"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Save, AlertCircle, Image, ChevronLeft, ChevronRight, X, RefreshCw, Download, Printer, Upload, GitMerge as MergeIcon } from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  getPreviewData, 
  submitForApproval,
  getSubmittedPreviewData,
  resubmitReport,
  getAssetCategorySpecs,
  uploadPreviewLotImages,
  type AssetCategorySpec,
} from "@/services/assets";
import { SAVE_PREVIEW_TITLE } from "@/lib/previewSave";
import { mergeSubmittedPreviewData } from "@/lib/previewSaveMerge";
import BottomDrawer from "@/components/BottomDrawer";
import AuctioneerSpecsEditor from "@/components/reports/AuctioneerSpecsEditor";
import FloatingPhotoViewer from "@/components/reports/FloatingPhotoViewer";
import {
  normalizePreviewLocationData,
} from "@/lib/browserLocation";
import { usePreviewLocation } from "@/components/reports/usePreviewLocation";
import { ReportsService } from "@/services/reports";
import {
  applyDamageAnalysisLotPolicy,
  getLotNumberForDamagePolicy,
  isDamageAnalysisEligibleForLot,
} from "@/lib/lotDamagePolicy";
import {
  removeGalleryPhotoEntry,
  removeLotPhotoReference,
} from "@/lib/previewPhotoDeletion";
import {
  applyPrimarySerialEdit,
} from "@/lib/previewSerialNumber";
import { applyPreviewSpecEdit } from "@/lib/previewSpecEdits";
import { getPreviewLotPhotoEntries } from "@/lib/previewLotPhotos";
import {
  buildLotValuationLines,
  formatLotValuationValue,
  type LotValuationLine,
} from "@/components/reports/lotValuationMethods";
import { ReportDraftService } from "@/services/reportDrafts";
import AssetCoverImagePicker from "@/components/reports/AssetCoverImagePicker";
import {
  collectAssetCoverImageUrls,
  normalizeAssetCoverImageUrls,
} from "@/lib/assetCoverImages";
import { useExclusivePreviewMutation } from "@/components/reports/useExclusivePreviewMutation";
import AssetConditionSelectionFields from "@/components/reports/AssetConditionSelectionFields";
import {
  ASSET_CONDITION_SELECTION_GROUPS,
  applyAssetConditionSelectionToLots,
  getSharedAssetConditionSelection,
  normalizeAssetConditionSelection,
  type AssetConditionSelectionKey,
} from "@/lib/assetConditionSelections";

interface PreviewModalProps {
  reportId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (submittedReport?: any) => void;
  isResubmitMode?: boolean; // If true, this is for editing/resubmitting an already submitted report
  loadPreviewDataOverride?: (reportId: string) => Promise<any>;
  updatePreviewDataOverride?: (
    reportId: string,
    previewData: any
  ) => Promise<{
    message: string;
    data: any;
    imageUrls?: string[];
    image_count?: number;
    files_regeneration_queued?: boolean;
  }>;
  resubmitReportOverride?: (
    reportId: string,
    previewData?: any
  ) => Promise<{ message: string; data: any }>;
  uploadPreviewLotImagesOverride?: (
    reportId: string,
    lotKey: string | number,
    files: File[],
    previewData?: any,
    onProgress?: (progress: number) => void
  ) => Promise<any>;
  refreshAssetSpecPdfOverride?: (reportId: string) => Promise<{
    message: string;
    data: {
      spec_pdf: string;
      cr_docx?: string;
      preview_files?: Record<string, string>;
      preview_data?: any;
      imageUrls?: string[];
      image_count?: number;
    };
  }>;
  isAssignedApprovalMode?: boolean;
  draftPreviewId?: string;
}

type FocusableFormElement =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLSelectElement;

type ExpandableLotTextField =
  | "lot_number"
  | "title"
  | "categories"
  | "estimated_value";

type ExpandedLotTextEditor = {
  lotIndex: number;
  field: ExpandableLotTextField;
  variant: "mobile" | "desktop";
};

type LotGalleryEntry = {
  url: string;
  globalIndex: number | null;
  lotIndex: number;
};

type LotGalleryState = {
  entries: LotGalleryEntry[];
  currentIdx: number;
};

const LOTS_PER_PAGE = 20;

function useDesktopPreviewLayout() {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }
    return window.matchMedia("(min-width: 768px)").matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const updateLayout = () => setIsDesktop(mediaQuery.matches);
    updateLayout();
    mediaQuery.addEventListener?.("change", updateLayout);
    return () => mediaQuery.removeEventListener?.("change", updateLayout);
  }, []);

  return isDesktop;
}

const normalizeSpecKey = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const getLotDisplayNumber = (lot: any, index: number) => {
  const candidates = [lot?.lot_number, lot?.lot_id, lot?.lot, lot?.id];
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (text) return text;
  }
  return String(index + 1);
};

function SelectedValuationMethods({
  lines,
  lotLabel,
}: {
  lines: LotValuationLine[];
  lotLabel: string;
}) {
  if (!lines.length) {
    return <span className="text-xs text-[var(--app-text-muted)]">None selected</span>;
  }

  return (
    <ul className="space-y-1.5" aria-label={`Selected valuation methods for lot ${lotLabel}`}>
      {lines.map((line) => (
        <li key={line.method} className="min-w-0">
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-alt)] px-2 py-1 text-[11px] font-bold text-[var(--app-text)]">
            <span>{line.method}</span>
            {line.percentage !== null ? (
              <span className="font-medium text-[var(--app-text-muted)]">
                {line.percentage}%
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-[var(--app-text-muted)]" title={line.fullName}>
            {line.fullName}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LotValuationValues({
  lines,
  currency,
  lotLabel,
}: {
  lines: LotValuationLine[];
  currency: unknown;
  lotLabel: string;
}) {
  if (!lines.length) return null;

  return (
    <dl className="mt-2 space-y-1.5 border-t border-[var(--app-border)] pt-2" aria-label={`Valuation method values for lot ${lotLabel}`}>
      {lines.map((line) => (
        <div key={line.method} className="flex items-center justify-between gap-2 text-xs">
          <dt className="font-bold text-[var(--app-text-muted)]">{line.method}</dt>
          <dd className="text-right font-semibold tabular-nums text-[var(--app-text)]">
            {formatLotValuationValue(line.value, currency)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

type SignaturePadProps = {
  value?: string;
  disabled?: boolean;
  onChange: (value: string | null) => void;
};

const SIGNATURE_CANVAS_WIDTH = 900;
const SIGNATURE_CANVAS_HEIGHT = 260;

function AppraiserSignaturePad({ value, disabled, onChange }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasInkRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  const clearCanvas = React.useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    clearCanvas();
    hasInkRef.current = false;

    if (!value) return;

    const image = new window.Image();
    image.onload = () => {
      clearCanvas();
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      hasInkRef.current = true;
    };
    image.src = value;
  }, [clearCanvas, value]);

  const getCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const point = getCanvasPoint(event);
    if (!canvas || !ctx || !point) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    hasInkRef.current = true;
    lastPointRef.current = point;

    ctx.fillStyle = "#111827";
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || !drawingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const point = getCanvasPoint(event);
    const lastPoint = lastPointRef.current;
    if (!canvas || !ctx || !point || !lastPoint) return;

    event.preventDefault();
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
  };

  const finishDrawing = () => {
    const canvas = canvasRef.current;
    if (!drawingRef.current || !canvas) return;
    drawingRef.current = false;
    lastPointRef.current = null;
    if (hasInkRef.current) {
      onChange(canvas.toDataURL("image/png"));
    }
  };

  const handleClear = () => {
    if (disabled) return;
    clearCanvas();
    hasInkRef.current = false;
    drawingRef.current = false;
    lastPointRef.current = null;
    onChange(null);
  };

  return (
    <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <label className="block text-xs sm:text-sm font-semibold text-[var(--app-text)]">
            Appraiser Signature
          </label>
          <p className="mt-0.5 text-xs text-[var(--app-text-muted)]">
            This signature is added to the DOCX appraisal signature areas.
          </p>
        </div>
        <button
          type="button"
          onClick={handleClear}
          disabled={disabled || !value}
          className="app-button app-button--secondary !min-h-8 !px-3 !py-1 !text-xs"
        >
          Clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        width={SIGNATURE_CANVAS_WIDTH}
        height={SIGNATURE_CANVAS_HEIGHT}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrawing}
        onPointerCancel={finishDrawing}
        onPointerLeave={finishDrawing}
        className={`h-40 w-full touch-none rounded-lg border border-dashed border-[var(--app-control-border)] bg-white ${
          disabled ? "cursor-not-allowed opacity-60" : "cursor-crosshair"
        }`}
        aria-label="Draw appraiser signature"
      />
      <p className="mt-2 text-xs text-[var(--app-text-muted)]">
        {value ? "Saved signature ready for DOCX generation." : "Draw inside the box, then save and generate files."}
      </p>
    </div>
  );
}

export default function PreviewModal({
  reportId,
  isOpen,
  onClose,
  onSuccess,
  isResubmitMode = false,
  loadPreviewDataOverride,
  resubmitReportOverride,
  uploadPreviewLotImagesOverride,
  isAssignedApprovalMode = false,
  draftPreviewId,
}: PreviewModalProps) {
  // Single-page layout (tabs removed)
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [declineReason, setDeclineReason] = useState<string>("");
  const [filesGenerating, setFilesGenerating] = useState(false);
  const [filesRegenerating, setFilesRegenerating] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const previewDataRef = useRef<any>(null);
  previewDataRef.current = previewData;
  const loadRequestRef = useRef(0);
  const previewContextRef = useRef("");
  previewContextRef.current = JSON.stringify([
    reportId,
    isOpen,
    draftPreviewId || "",
    isAssignedApprovalMode,
    isResubmitMode,
  ]);
  const {
    activeMutation,
    beginMutation,
    finishMutation,
    hasChanges,
    hasEditsSince,
    isMutationLocked,
    setHasChanges,
  } = useExclusivePreviewMutation();
  const [groupingMode, setGroupingMode] = useState<string | undefined>(undefined);
  const [imageCount, setImageCount] = useState<number | undefined>(undefined);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [uploadingLotKey, setUploadingLotKey] = useState<string | null>(null);
  const [previewFiles, setPreviewFiles] = useState<any>(null);
  const [categorySpecs, setCategorySpecs] = useState<AssetCategorySpec[]>([]);
  const [lotPage, setLotPage] = useState(1);
  const lotPageStartRef = useRef<HTMLDivElement>(null);
  const focusLotPageStartRef = useRef(false);
  const [selectedLotIndexes, setSelectedLotIndexes] = useState<Set<number>>(
    () => new Set()
  );
  const [bulkSelectionStatus, setBulkSelectionStatus] = useState("");
  const [expandedLotTextEditor, setExpandedLotTextEditor] = useState<ExpandedLotTextEditor | null>(null);
  // For lot-specific gallery view
  const [galleryLotImages, setGalleryLotImages] = useState<LotGalleryState | null>(null);
  const isDesktopLayout = useDesktopPreviewLayout();
  const {
    isLocationReady,
    locationAttribution,
    locationAttributionUrl,
    locationBusy,
    locationStatus,
    requestCurrentLocation,
    updateLocation,
  } = usePreviewLocation({
    isOpen,
    previewData,
    setPreviewData,
    setHasChanges,
  });
  const effectiveResubmitMode = isAssignedApprovalMode || (status
    ? status === "pending_approval" || status === "approved" || status === "error"
    : isResubmitMode);
  const loadAssetPreview = (id: string) =>
    loadPreviewDataOverride
      ? loadPreviewDataOverride(id)
      : isResubmitMode
        ? getSubmittedPreviewData(id)
        : getPreviewData(id);
  const editorLocked = activeMutation !== null;
  const focusStateRef = useRef<{
    fieldId: string | null;
    selectionStart: number | null;
    selectionEnd: number | null;
  }>({
    fieldId: null,
    selectionStart: null,
    selectionEnd: null,
  });

  useEffect(() => {
    if (isOpen && reportId) {
      loadPreviewData();
    }
    return () => {
      loadRequestRef.current += 1;
    };
  }, [isOpen, reportId, isResubmitMode]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    const { fieldId, selectionStart, selectionEnd } = focusStateRef.current;
    if (!fieldId || typeof document === "undefined") return;

    const activeElement = document.activeElement as HTMLElement | null;
    if (activeElement?.dataset.focusId === fieldId) return;

    const target = document.querySelector<FocusableFormElement>(
      `[data-focus-id="${fieldId}"]`
    );
    if (!target) return;

    target.focus({ preventScroll: true });

    if (
      typeof selectionStart === "number" &&
      typeof selectionEnd === "number" &&
      "setSelectionRange" in target
    ) {
      try {
        target.setSelectionRange(selectionStart, selectionEnd);
      } catch {
        // Ignore inputs that don't support text selection.
      }
    }
  }, [expandedLotTextEditor, isDesktopLayout, isOpen, loading, lotPage]);

  useEffect(() => {
    if (!expandedLotTextEditor) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeExpandedLotTextEditor();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [expandedLotTextEditor]);

  const rememberFocusState = (element: FocusableFormElement) => {
    const fieldId = element.dataset.focusId;
    if (!fieldId) return;

    focusStateRef.current = {
      fieldId,
      selectionStart:
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.selectionStart
          : null,
      selectionEnd:
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.selectionEnd
          : null,
    };
  };

  const getFocusTrackingProps = (fieldId: string) => ({
    "data-focus-id": fieldId,
    onFocusCapture: (event: React.SyntheticEvent<FocusableFormElement>) =>
      rememberFocusState(event.currentTarget),
    onChangeCapture: (event: React.SyntheticEvent<FocusableFormElement>) =>
      rememberFocusState(event.currentTarget),
    onSelectCapture: (event: React.SyntheticEvent<FocusableFormElement>) =>
      rememberFocusState(event.currentTarget),
    onClickCapture: (event: React.SyntheticEvent<FocusableFormElement>) =>
      rememberFocusState(event.currentTarget),
    onKeyUpCapture: (event: React.SyntheticEvent<FocusableFormElement>) =>
      rememberFocusState(event.currentTarget),
  });

  function closeExpandedLotTextEditor() {
    if (focusStateRef.current.fieldId?.startsWith("expanded-lot-")) {
      focusStateRef.current = {
        fieldId: null,
        selectionStart: null,
        selectionEnd: null,
      };
    }
    setExpandedLotTextEditor(null);
  }

  /** Applies the owner-bound preview read. */
  const applyAssetPreviewResponse = (response: any) => {
    const data = response?.data || {};
    setStatus(data.status);
    setFilesGenerating(Boolean(data.files_generating));
    setFilesRegenerating(Boolean(data.files_regenerating));
    setDeclineReason(data.decline_reason || "");
    setPreviewData(
      applyDamageAnalysisLotPolicy(
        normalizePreviewLocationData(data.preview_data || {})
      )
    );
    setPreviewFiles(data.preview_files || null);
    setGroupingMode(data.grouping_mode);
    setImageCount(data.image_count);
    setImageUrls(data.imageUrls || []);
  };

  const loadPreviewData = async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    try {
      setLoading(true);
      setFilesGenerating(false);
      setFilesRegenerating(false);
      // Use different endpoint based on mode
      const [response, categorySpecResponse] = await Promise.all([
        loadAssetPreview(reportId),
        getAssetCategorySpecs().catch(() => ({ categories: [], specs: [] })),
      ]);
      if (loadRequestRef.current !== requestId) return;
      setCategorySpecs(categorySpecResponse.specs || []);
      applyAssetPreviewResponse(response);
      setLotPage(1);
      setSelectedLotIndexes(new Set());
      setHasChanges(false);
    } catch (error: any) {
      if (loadRequestRef.current !== requestId) return;
      toast.error(error.response?.data?.message || "Failed to load preview data");
      onClose();
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  };

  const handleSubmitForApproval = async () => {
    if (isMutationLocked()) return;
    if (!previewData) {
      toast.error("No preview data available");
      return;
    }

    if (!isLocationReady) {
      toast.error(
        "Enter or resolve a readable inspection location before submitting."
      );
      return;
    }

    if (locationBusy) {
      toast.info("Wait for the inspection location to finish resolving.");
      return;
    }

    if (filesGenerating || filesRegenerating) {
      toast.info("This report has already been submitted and is still generating files.");
      return;
    }

    const mutation = beginMutation("submit");
    if (!mutation) return;
    const mutationContext = previewContextRef.current;

    try {
      setSubmitting(true);
      setSelectedLotIndexes(new Set());
      let submittedReport: any;
      const previewForRequest = applyDamageAnalysisLotPolicy(previewData);
      setPreviewData(previewForRequest);
      
      if (draftPreviewId) {
        // A draft preview is an intentionally hidden derivative. Promote and
        // submit it in one request so the exact edited snapshot owns every
        // generated artifact and the report becomes visible in normal queues.
        const promoted = await ReportDraftService.promotePreview(draftPreviewId, {
          preview_data: previewForRequest,
          submit: true,
        });
        if (previewContextRef.current !== mutationContext) return;
        setFilesGenerating(true);
        submittedReport = {
          ...promoted,
          _id: promoted.reportId,
        };
        if (!hasEditsSince(mutation)) setHasChanges(false);
        toast.success("Draft moved to reports. Files are being generated from your saved preview.");
      } else if (effectiveResubmitMode) {
        // For resubmit mode: save changes and resubmit in one call
        const submitUpdatedReport = resubmitReportOverride || resubmitReport;
        await submitUpdatedReport(reportId, previewForRequest);
        if (previewContextRef.current !== mutationContext) return;
        if (!hasEditsSince(mutation)) setHasChanges(false);
        setFilesGenerating(true);
        setFilesRegenerating(true);
        toast.success(
          isAssignedApprovalMode
            ? "Files are regenerating. The report will approve after generation succeeds."
            : "Changes saved. Files are being regenerated from your updated data."
        );
      } else {
        // Submit the exact edited snapshot in one request. Saving first and then
        // submitting allowed the second request to queue an older preview copy.
        const submitted = await submitForApproval(reportId, previewForRequest);
        if (previewContextRef.current !== mutationContext) return;
        setFilesGenerating(true);
        submittedReport = { ...submitted.data, _id: submitted.data?.reportId || reportId };
        if (!hasEditsSince(mutation)) setHasChanges(false);
        toast.success(submitted.message || "Report submitted. Files are being generated.");
      }
      
      if (onSuccess) {
        onSuccess(
          draftPreviewId
            ? submittedReport
            : effectiveResubmitMode
              ? undefined
              : submittedReport
        );
      }
      onClose();
    } catch (error: any) {
      if (previewContextRef.current === mutationContext) {
        toast.error(error.response?.data?.message || "Failed to submit report");
      }
    } finally {
      setSubmitting(false);
      finishMutation(mutation);
    }
  };

  const updateField = (field: string, value: any) => {
    setPreviewData((prev: any) => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const updateAppraiserSignature = (dataUrl: string | null) => {
    setPreviewData((prev: any) => {
      const next = { ...(prev || {}) };
      if (dataUrl) {
        next.appraiser_signature_data_url = dataUrl;
        next.appraiser_signature_updated_at = new Date().toISOString();
      } else {
        delete next.appraiser_signature_data_url;
        delete next.appraiser_signature_updated_at;
      }
      return next;
    });
    setHasChanges(true);
  };

  // Normalize currency prefixes in display value strings without converting amounts
  const handleCurrencyChange = (newCurrency: string) => {
    const normalize = (val: any) => {
      const s = String(val || "");
      if (!s) return s;
      // keep numeric part, dots and commas
      const num = s.replace(/[^0-9.,-]/g, "").replace(/^,+/, "");
      return num ? `${newCurrency} ${num}` : s;
    };

    setPreviewData((prev: any) => {
      const next: any = { ...prev, currency: newCurrency };
      if (next.total_appraised_value != null) {
        next.total_appraised_value = normalize(next.total_appraised_value);
      }
      if (Array.isArray(next.lots)) {
        next.lots = next.lots.map((lot: any) => ({
          ...lot,
          estimated_value: normalize(lot.estimated_value),
        }));
      }
      // Leave valuation_data numeric fields untouched; UI shows currency label separately
      return next;
    });
    setHasChanges(true);
  };

  // Valuation editors (nested)
  const updateValuationBase = (base: number) => {
    setPreviewData((prev: any) => {
      const vd = { ...(prev?.valuation_data || {}) };
      vd.baseFMV = isNaN(base as any) ? vd.baseFMV : base;
      // Optionally sync percentages when base changes (keep values as-is)
      return { ...prev, valuation_data: vd };
    });
    setHasChanges(true);
  };

  const updateValuationMethod = (
    index: number,
    field: "fullName" | "description" | "value" | "saleConditions" | "timeline" | "useCase",
    value: any
  ) => {
    setPreviewData((prev: any) => {
      const vd = { ...(prev?.valuation_data || {}) } as any;
      const methods = Array.isArray(vd.methods) ? [...vd.methods] : [];
      const m = { ...(methods[index] || {}) } as any;
      m[field] = value;
      if (field === "value") {
        const base = Number(vd.baseFMV) || 0;
        const numVal = Number(value);
        if (base > 0 && isFinite(numVal)) {
          m.percentage = Math.round((numVal / base) * 100);
        }
      }
      methods[index] = m;
      return { ...prev, valuation_data: { ...vd, methods } };
    });
    setHasChanges(true);
  };

  const updateLot = (index: number, field: string, value: any) => {
    setPreviewData((prev: any) => {
      const newLots = [...(prev.lots || [])];
      const nextLot =
        field === "serial_number"
          ? applyPrimarySerialEdit(newLots[index] || {}, value)
          : { ...newLots[index], [field]: value };
      if (
        field === "lot_number" &&
        !isDamageAnalysisEligibleForLot(getLotNumberForDamagePolicy(nextLot))
      ) {
        nextLot.damage_analysis = "";
      }
      newLots[index] = nextLot;
      return { ...prev, lots: newLots };
    });
    setHasChanges(true);
  };

  const updateLotConditionSelection = (index: number, key: AssetConditionSelectionKey, value: string) => {
    if (isMutationLocked() || filesGenerating || filesRegenerating) return;
    setPreviewData((prev: any) => ({
      ...prev,
      lots: applyAssetConditionSelectionToLots(prev?.lots || [], new Set([index]), key, value),
    }));
    setHasChanges(true);
  };

  const applyConditionSelectionToSelectedLots = (key: AssetConditionSelectionKey, value: string) => {
    if (isMutationLocked() || filesGenerating || filesRegenerating) return;
    const lotCount = Array.isArray(previewData?.lots)
      ? previewData.lots.length
      : 0;
    const targetIndexes = new Set(
      Array.from(selectedLotIndexes).filter(
        (index) => index >= 0 && index < lotCount
      )
    );
    if (targetIndexes.size === 0) {
      toast.info("Select at least one lot before applying a required selection.");
      return;
    }

    setPreviewData((prev: any) => ({
      ...prev,
      lots: applyAssetConditionSelectionToLots(prev?.lots || [], targetIndexes, key, value),
    }));
    setHasChanges(true);
    setBulkSelectionStatus(
      `${value} applied to ${targetIndexes.size} selected lot${
        targetIndexes.size === 1 ? "" : "s"
      }.`,
    );
  };

  const changeLotSpec = (index: number, fieldName: string, value: string, options: { deleted?: boolean; added?: boolean } = {}) => {
    setPreviewData((prev: any) => {
      const newLots = [...(prev?.lots || [])];
      const lot = newLots[index] || {};
      const categoryFields = categorySpecs.find(spec => normalizeSpecKey(spec.childCategory) === normalizeSpecKey(lot.categories))?.fields || [];
      newLots[index] = applyPreviewSpecEdit(lot, fieldName, value, categoryFields, options);
      return { ...prev, lots: newLots };
    });
    setHasChanges(true);
  };
  const updateLotSpec = (index: number, fieldName: string, value: string) => changeLotSpec(index, fieldName, value);
  const deleteLotSpec = (index: number, fieldName: string) => changeLotSpec(index, fieldName, '', { deleted: true });
  const addLotSpec = (index: number, fieldName: string, value: string) => changeLotSpec(index, fieldName, value, { added: true });

  const deleteLotImage = (
    lotIndex: number,
    entry: Pick<LotGalleryEntry, "globalIndex" | "url">
  ) => {
    if (
      !window.confirm(
        "Remove this photo from the lot? It will be permanently deleted from storage after you save and generate files. Closing without saving leaves storage unchanged."
      )
    ) {
      return;
    }
    setPreviewData((prev: any) => {
      const next = removeLotPhotoReference(prev, lotIndex, entry);
      const activeCandidates = collectAssetCoverImageUrls(next, imageUrls);
      return {
        ...next,
        cover_image_urls: normalizeAssetCoverImageUrls(
          next?.cover_image_urls,
          activeCandidates
        ),
      };
    });
    setGalleryLotImages((prev) => {
      if (!prev) return prev;
      const next = removeGalleryPhotoEntry(prev.entries, prev.currentIdx, {
        ...entry,
        lotIndex,
      });
      return next.entries.length ? next : null;
    });
    setHasChanges(true);
  };

  const getLotUploadKey = (lot: any, index: number) =>
    String(lot?.lot_id || lot?.id || lot?.lot_number || index);

  const getLotPhotoEntries = (lot: any) =>
    getPreviewLotPhotoEntries(lot, imageUrls);

  const handleUploadLotImages = async (lot: any, index: number, fileList: FileList | null) => {
    if (isMutationLocked()) return;
    if (filesGenerating || filesRegenerating) return;
    const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    const mutation = beginMutation("upload");
    if (!mutation) return;
    const mutationContext = previewContextRef.current;
    const lotKey = getLotUploadKey(lot, index);
    setUploadingLotKey(lotKey);
    try {
      const uploadLotImages = uploadPreviewLotImagesOverride || uploadPreviewLotImages;
      const previewForRequest = applyDamageAnalysisLotPolicy(previewData);
      setPreviewData(previewForRequest);
      const response = await uploadLotImages(reportId, lotKey, files, previewForRequest);
      if (previewContextRef.current !== mutationContext) return;
      if (response.data?.preview_data) {
        const nextPreview = hasEditsSince(mutation)
          ? mergeSubmittedPreviewData(
              response.data.preview_data,
              previewDataRef.current || previewForRequest
            )
          : response.data.preview_data;
        setPreviewData(applyDamageAnalysisLotPolicy(nextPreview));
        setSelectedLotIndexes(new Set());
      }
      if (Array.isArray(response.data?.imageUrls)) {
        setImageUrls(response.data.imageUrls);
        setImageCount(response.data.imageUrls.length);
      }
      if (response.data?.preview_files) {
        setPreviewFiles(response.data.preview_files);
      }
      setFilesGenerating(Boolean(response.data?.files_generating));
      setFilesRegenerating(Boolean(response.data?.files_regenerating));
      if (!hasEditsSince(mutation)) setHasChanges(false);
      toast.success(
        response.message ||
          (response.files_regeneration_queued
            ? "Images uploaded. Files are regenerating."
            : "Images uploaded.")
      );
    } catch (error: any) {
      if (previewContextRef.current === mutationContext) {
        toast.error(error?.response?.data?.message || "Failed to upload images.");
      }
    } finally {
      setUploadingLotKey(null);
      finishMutation(mutation);
    }
  };

  const specsByCategory = React.useMemo(
    () =>
      new Map(
        categorySpecs.map((spec) => [
          String(spec.childCategory || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ""),
          spec,
        ])
      ),
    [categorySpecs]
  );

  const lotTextFieldMeta: Record<ExpandableLotTextField, { label: string; placeholder: string }> = {
    lot_number: {
      label: "Lot #",
      placeholder: "Lot number",
    },
    title: {
      label: "Title",
      placeholder: "Asset title",
    },
    categories: {
      label: "Category",
      placeholder: "Auctioneer Import category",
    },
    estimated_value: {
      label: "Estimated Value",
      placeholder: "e.g., $25,000",
    },
  };

  const openLotFieldEditor = (
    lotIndex: number,
    field: ExpandableLotTextField,
    variant: "mobile" | "desktop"
  ) => {
    setExpandedLotTextEditor({ lotIndex, field, variant });
  };

  const renderFieldEditorButton = (
    lotIndex: number,
    field: ExpandableLotTextField,
    variant: "mobile" | "desktop"
  ) => (
    <button
      type="button"
      onClick={() => openLotFieldEditor(lotIndex, field, variant)}
      className="app-button app-button--secondary !min-h-7 !rounded-md !px-2 !py-1 !text-[11px]"
      aria-label={`Open ${lotTextFieldMeta[field].label} editor`}
    >
      Edit
    </button>
  );

  const deleteLot = (index: number) => {
    setSelectedLotIndexes(new Set());
    setPreviewData((prev: any) => {
      const lots = Array.isArray(prev?.lots) ? [...prev.lots] : [];
      lots.splice(index, 1);
      return { ...prev, lots };
    });
    setHasChanges(true);
  };

  const addLot = () => {
    setSelectedLotIndexes(new Set());
    setLotPage(Math.max(1, Math.ceil((lotsArray.length + 1) / LOTS_PER_PAGE)));
    setPreviewData((prev: any) => {
      const lots = Array.isArray(prev?.lots) ? [...prev.lots] : [];
      const usedNumbers = new Set(
        lots
          .map((lot: any) => Number.parseInt(String(lot?.lot_number || ""), 10))
          .filter((value: number) => Number.isFinite(value) && value > 0)
      );
      let nextLotNumber = lots.length + 1;
      while (usedNumbers.has(nextLotNumber)) nextLotNumber += 1;
      const previousLot = lots[lots.length - 1] || {};
      lots.push({
        lot_id: `lot-${Date.now()}`,
        lot_number: String(nextLotNumber),
        title: "",
        categories: "",
        description: "",
        details: "",
        estimated_value: "",
        image_indexes: [],
        image_urls: [],
        extra_image_indexes: [],
        extra_image_urls: [],
        mixed_group_index: Number(previousLot?.mixed_group_index) || 1,
        sub_mode: previousLot?.sub_mode || "single_lot",
        condition_report_specs: {},
      });
      return { ...(prev || {}), lots };
    });
    setHasChanges(true);
    toast.success("New lot added. Fill in the details before resubmitting.");
  };

  const updateLotItem = (
    lotIndex: number,
    itemIndex: number,
    field: string,
    value: any
  ) => {
    setPreviewData((prev: any) => {
      const newLots = [...(prev.lots || [])];
      const lot = { ...(newLots[lotIndex] || {}) } as any;
      const items = Array.isArray(lot.items) ? [...lot.items] : [];
      items[itemIndex] = { ...(items[itemIndex] || {}), [field]: value };
      lot.items = items;
      newLots[lotIndex] = lot;
      return { ...prev, lots: newLots };
    });
    setHasChanges(true);
  };

  // Group lots by mixed_group_index and determine sub-mode label
  const lotsArray: any[] = Array.isArray(previewData?.lots) ? previewData.lots : [];
  const deletedImageUrls = previewData?.deleted_image_urls;
  const deletedImageIndexes = previewData?.deleted_image_indexes;
  const coverImageCandidates = React.useMemo(
    () =>
      collectAssetCoverImageUrls(
        {
          deleted_image_urls: deletedImageUrls,
          deleted_image_indexes: deletedImageIndexes,
        },
        imageUrls
      ),
    [deletedImageIndexes, deletedImageUrls, imageUrls]
  );
  const selectedCoverImageUrls = React.useMemo(
    () =>
      normalizeAssetCoverImageUrls(
        previewData?.cover_image_urls,
        coverImageCandidates
      ),
    [coverImageCandidates, previewData?.cover_image_urls]
  );
  const duplicateLotNumberKeys = React.useMemo(() => {
    const counts = new Map<string, number>();
    lotsArray.forEach((lot, index) => {
      const key = String(lot?.lot_number ?? getLotDisplayNumber(lot, index)).trim().toLowerCase();
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([key]) => key)
    );
  }, [lotsArray]);
  const isDuplicateLotNumber = (lot: any, index: number) =>
    duplicateLotNumberKeys.has(
      String(lot?.lot_number ?? getLotDisplayNumber(lot, index)).trim().toLowerCase()
    );
  const includeDamageAnalysis = previewData?.include_damage_analysis !== false;
  const lotPageCount = Math.max(1, Math.ceil(lotsArray.length / LOTS_PER_PAGE));
  const activeLotPage = Math.min(lotPage, lotPageCount);
  const firstVisibleLotIndex = (activeLotPage - 1) * LOTS_PER_PAGE;
  const lastVisibleLotIndex = Math.min(
    firstVisibleLotIndex + LOTS_PER_PAGE,
    lotsArray.length
  );
  useLayoutEffect(() => {
    if (!isOpen || !focusLotPageStartRef.current) return;
    focusLotPageStartRef.current = false;
    lotPageStartRef.current?.focus({ preventScroll: true });
    lotPageStartRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [activeLotPage, isOpen]);
  const visibleLotIndexes = React.useMemo(
    () =>
      Array.from(
        { length: Math.max(0, lastVisibleLotIndex - firstVisibleLotIndex) },
        (_, offset) => firstVisibleLotIndex + offset
      ),
    [firstVisibleLotIndex, lastVisibleLotIndex]
  );
  const validSelectedLotIndexes = React.useMemo(
    () =>
      new Set(
        Array.from(selectedLotIndexes).filter(
          (index) => index >= 0 && index < lotsArray.length
        )
      ),
    [lotsArray.length, selectedLotIndexes]
  );
  const selectedLotCount = validSelectedLotIndexes.size;
  const allLotsSelected =
    lotsArray.length > 0 && selectedLotCount === lotsArray.length;
  const allVisibleLotsSelected =
    visibleLotIndexes.length > 0 &&
    visibleLotIndexes.every((index) => validSelectedLotIndexes.has(index));

  useEffect(() => {
    setLotPage((current) => Math.min(Math.max(current, 1), lotPageCount));
  }, [lotPageCount]);

  useEffect(() => {
    setBulkSelectionStatus("");
  }, [selectedLotIndexes]);

  const toggleLotSelection = (index: number) => {
    setSelectedLotIndexes((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleAllLotSelection = () => {
    setSelectedLotIndexes(
      allLotsSelected
        ? new Set()
        : new Set(lotsArray.map((_, index) => index))
    );
  };

  const toggleVisibleLotSelection = () => {
    setSelectedLotIndexes((current) => {
      const next = new Set(current);
      for (const index of visibleLotIndexes) {
        if (allVisibleLotsSelected) next.delete(index);
        else next.add(index);
      }
      return next;
    });
  };

  const labelForSubMode = (m?: string) => {
    const sm = String(m || "").trim();
    if (sm === "per_item") return "Per Item";
    if (sm === "per_photo") return "Per Photo";
    if (sm === "single_lot") return "Bundle";
    // fallback to groupingMode string
    const gm = String(groupingMode || previewData?.grouping_mode || "mixed");
    if (gm === "per_item") return "Per Item";
    if (gm === "per_photo") return "Per Photo";
    if (gm === "single_lot") return "Bundle";
    return "Assets";
  };
  const groupedLots = React.useMemo(() => {
    const groupMap = new Map<number, { idx: number; lot: any }[]>();
    lotsArray
      .slice(firstVisibleLotIndex, lastVisibleLotIndex)
      .forEach((lot, offset) => {
        const gid = Number(lot?.mixed_group_index) || 0;
        if (!groupMap.has(gid)) groupMap.set(gid, []);
        groupMap.get(gid)!.push({ idx: firstVisibleLotIndex + offset, lot });
      });

    return Array.from(groupMap.keys())
      .sort((a, b) => a - b)
      .map((gid) => {
        const items = groupMap.get(gid) || [];
        const first = items[0]?.lot || {};
        const inferredMode =
          first?.sub_mode ||
          ((first?.tags || [])
            .find?.(
              (tag: string) =>
                typeof tag === "string" && tag.startsWith("mode:")
            )
            ?.split?.(":")?.[1] || undefined);
        return { gid, subMode: inferredMode, items };
      });
  }, [firstVisibleLotIndex, lastVisibleLotIndex, lotsArray]);

  const sharedSelectedConditionValues = React.useMemo(
    () => Object.fromEntries(
      ASSET_CONDITION_SELECTION_GROUPS.map((group) => [
        group.key,
        getSharedAssetConditionSelection(lotsArray, validSelectedLotIndexes, group.key),
      ]),
    ),
    [lotsArray, validSelectedLotIndexes],
  );

  const renderConditionSelections = (
    lot: any,
    index: number,
    variant: "mobile" | "desktop",
  ) => (
    <AssetConditionSelectionFields
      lot={lot}
      lotIndex={index}
      lotLabel={getLotDisplayNumber(lot, index)}
      variant={variant}
      disabled={activeMutation !== null || filesGenerating || filesRegenerating}
      onChange={updateLotConditionSelection}
    />
  );

  const renderLotSelectionCheckbox = (
    lot: any,
    index: number,
    variant: "mobile" | "desktop"
  ) => {
    if (lotsArray.length < 2) return null;
    const lotLabel = getLotDisplayNumber(lot, index);
    const selected = validSelectedLotIndexes.has(index);

    return (
      <label
        className={`inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-xs font-semibold transition-colors ${
          selected
            ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)] text-[var(--app-accent)]"
            : "border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text-muted)] hover:border-[var(--app-control-border-hover)] hover:text-[var(--app-text)]"
        }`}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => toggleLotSelection(index)}
          aria-label={`Select lot ${lotLabel}, row ${index + 1}`}
          className="h-4 w-4 shrink-0 accent-[var(--app-accent)]"
        />
        {variant === "mobile" ? (
          <span>{selected ? "Selected" : "Select"}</span>
        ) : null}
      </label>
    );
  };

  const renderBulkConditionSelection = () => {
    if (lotsArray.length < 2) return null;

    return (
      <section
        aria-label="Bulk required selections"
        className="rounded-lg border border-[var(--app-info-border)] bg-[var(--app-info-soft)] p-3"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h4 className="text-sm font-bold text-[var(--app-text-strong)]">
                Bulk required selections
              </h4>
              <p
                className="text-xs text-[var(--app-text-muted)]"
                aria-live="polite"
              >
                {selectedLotCount > 0
                  ? `${selectedLotCount} of ${lotsArray.length} lots selected. Apply a value below or adjust any lot individually.`
                  : "Select the lots that should receive the same required selections."}
              </p>
            </div>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Select lots for bulk required selections"
            >
              {lotPageCount > 1 ? (
                <button
                  type="button"
                  onClick={toggleVisibleLotSelection}
                  aria-pressed={allVisibleLotsSelected}
                  aria-label={`${
                    allVisibleLotsSelected ? "Unselect" : "Select"
                  } ${visibleLotIndexes.length} lots on this page`}
                  className={`app-button !min-h-8 !px-3 !py-1.5 !text-xs ${
                    allVisibleLotsSelected
                      ? "app-button--primary"
                      : "app-button--secondary"
                  }`}
                >
                  {allVisibleLotsSelected ? "Unselect page" : "Select page"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={toggleAllLotSelection}
                aria-pressed={allLotsSelected}
                aria-label={`${allLotsSelected ? "Unselect" : "Select"} all ${
                  lotsArray.length
                } lots`}
                className={`app-button !min-h-8 !px-3 !py-1.5 !text-xs ${
                  allLotsSelected
                    ? "app-button--primary"
                    : "app-button--secondary"
                }`}
              >
                {allLotsSelected
                  ? "Unselect all"
                  : `Select all (${lotsArray.length})`}
              </button>
              <button
                type="button"
                onClick={() => setSelectedLotIndexes(new Set())}
                disabled={selectedLotCount === 0}
                className="app-button app-button--secondary !min-h-8 !px-3 !py-1.5 !text-xs"
              >
                Clear selection
              </button>
            </div>
          </div>
          <div className="space-y-2 border-t border-[var(--app-info-border)] pt-3">
            {ASSET_CONDITION_SELECTION_GROUPS.map((group) => (
              <div key={group.key} className="flex flex-col gap-1.5 lg:flex-row lg:items-center lg:gap-3">
                <span className="text-xs font-bold text-[var(--app-text-strong)] lg:w-32 lg:shrink-0">
                  {group.label}
                </span>
                <div
                  className="flex min-w-0 flex-wrap gap-1.5"
                  role="group"
                  aria-label={`Apply ${group.label} value to selected lots`}
                >
                  {group.options.map((option) => {
                    const selected = selectedLotCount > 0 &&
                      sharedSelectedConditionValues[group.key] === normalizeAssetConditionSelection(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => applyConditionSelectionToSelectedLots(group.key, option)}
                        disabled={selectedLotCount === 0 || activeMutation !== null || filesGenerating || filesRegenerating}
                        aria-pressed={selected}
                        aria-label={`Apply ${option} to ${selectedLotCount} selected lot${selectedLotCount === 1 ? "" : "s"}`}
                        className={`app-button !min-h-8 !px-3 !py-1.5 !text-xs ${selected ? "app-button--primary" : "app-button--secondary"}`}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="text-xs text-[var(--app-text-muted)]">
              Each choice changes only that group for the selected lots. Other selections are kept; any lot can be adjusted individually.
            </p>
            <p role="status" aria-live="polite" className="min-h-4 text-xs font-semibold text-[var(--app-success)]">
              {bulkSelectionStatus}
            </p>
          </div>
        </div>
      </section>
    );
  };

  const changeLotPage = (page: number, position: "top" | "bottom") => {
    if (position === "bottom") {
      // Move the reader to the newly rendered page, not the old page's end.
      // Only focus/scroll change here; the full edited snapshot stays in state.
      focusStateRef.current = { fieldId: null, selectionStart: null, selectionEnd: null };
      focusLotPageStartRef.current = true;
    }
    setLotPage(Math.max(1, Math.min(lotPageCount, page)));
  };

  const renderLotPagination = (position: "top" | "bottom") => {
    if (lotPageCount <= 1) return null;
    return (
      <nav
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] px-3 py-2"
        aria-label={position === "top" ? "Asset lots pagination" : "Asset lots pagination bottom"}
      >
        <div className="min-w-0 text-xs font-medium text-[var(--app-text-muted)]" aria-live={position === "top" ? "polite" : undefined} aria-atomic="true">
          <p>Showing {firstVisibleLotIndex + 1}–{lastVisibleLotIndex} of {lotsArray.length} lots</p>
          <p className="mt-1">All {lotsArray.length} lots remain in this report.</p>
        </div>
        <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto">
          <button
            type="button"
            className="app-button app-button--secondary !min-h-8 !px-2.5 !py-1.5 !text-xs"
            onClick={() => changeLotPage(activeLotPage - 1, position)}
            disabled={activeLotPage === 1}
            aria-label="Previous lots page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Previous
          </button>
          <span className="text-center text-xs font-semibold text-[var(--app-text)]">
            Page {activeLotPage} of {lotPageCount}
          </span>
          <button
            type="button"
            className="app-button app-button--secondary !min-h-8 !px-2.5 !py-1.5 !text-xs"
            onClick={() => changeLotPage(activeLotPage + 1, position)}
            disabled={activeLotPage === lotPageCount}
            aria-label="Next lots page"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </nav>
    );
  };

  const workflowLocked = filesGenerating || filesRegenerating;
  const mutationMessage =
    activeMutation === "upload"
      ? "Uploading images and updating this preview…"
      : activeMutation === "submit"
          ? effectiveResubmitMode
            ? "Saving changes and queuing regenerated report files…"
            : "Saving changes and queuing report files…"
          : "";
  const lockMessage = activeMutation
    ? `${mutationMessage} Keep this page open until it finishes.`
    : "";
  const specPdfUrl = previewFiles?.spec_pdf;
  const crDocxUrl = previewFiles?.cr_docx;

  const handlePrintSpecPdf = () => {
    if (!specPdfUrl) return;
    const printWindow = window.open(specPdfUrl, "_blank", "noopener,noreferrer");
    if (!printWindow) {
      toast.info("Open the CR download, then print from your browser.");
      return;
    }
    window.setTimeout(() => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch {
        // Browser PDF viewers may block programmatic print for cross-origin files.
      }
    }, 1200);
  };

  const handleDownloadSpecPdf = async () => {
    try {
      const { blob, filename } = await ReportsService.downloadCr(reportId);
      const objectUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename || `asset-cr-${reportId}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
      toast.success(`Download started: ${anchor.download}`);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || "Unable to download CR.");
    }
  };

  const handleDownloadCrDocx = async () => {
    try {
      const { blob, filename } = await ReportsService.downloadCrDocx(reportId);
      const objectUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename || `asset-cr-${reportId}.docx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
      toast.success(`Download started: ${anchor.download}`);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || "Unable to download CR DOCX.");
    }
  };

  const requestClose = () => {
    if (isMutationLocked()) return;
    if (
      hasChanges &&
      !window.confirm("You have unsaved preview changes. Close without saving them?")
    ) {
      return;
    }
    onClose();
  };

  return (
    <BottomDrawer
      open={isOpen}
      onClose={requestClose}
      title="Preview & Edit Report"
      description="Review your edits, then Save: your edited details are used to rebuild all report files without re-reading photos. Existing approval and release steps still apply."
      fullscreen
      dismissOnBackdrop={false}
      closeDisabled={activeMutation !== null}
    >
      <div
        className="preview-editor relative min-h-full bg-[var(--app-bg)] text-[var(--app-text)]"
        aria-busy={editorLocked}
      >
      {editorLocked ? (
        <div
          className="sticky top-0 z-[70] mb-3 flex items-center gap-3 border border-[var(--app-info-border)] bg-[var(--app-info-soft)] px-4 py-3 text-sm font-semibold text-[var(--app-text-strong)] shadow-sm"
          role="status"
          aria-live="polite"
        >
          <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-[var(--app-info)]" />
          <span>{lockMessage}</span>
        </div>
      ) : null}
      <div
        inert={editorLocked ? true : undefined}
        className={editorLocked ? "pointer-events-none select-none opacity-60" : undefined}
      >
      {status === "declined" && declineReason && (
        <div className="app-alert app-alert--error mb-4 flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--app-danger)]" />
          <div>
            <p className="font-semibold text-[var(--app-text-strong)]">Report Declined</p>
            <p className="mt-1 text-sm text-[var(--app-danger)]">{declineReason}</p>
          </div>
        </div>
      )}

      {status === "error" && (
        <div role="alert" className="app-alert app-alert--error mb-4">
          Generation failed, but your saved preview is available. Review every lot and photo before saving and resubmitting. Missing analysis must be completed before submission.
        </div>
      )}

      {workflowLocked && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-[var(--app-info-border)] bg-[var(--app-info-soft)] p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--app-info)]" />
          <div>
            <p className="font-semibold text-[var(--app-text-strong)]">
              {filesRegenerating ? "Files are being regenerated" : "Report already submitted"}
            </p>
            <p className="mt-1 text-sm text-[var(--app-info)]">
              {filesRegenerating
                ? "This report is already in the submitted queue while the new files are being regenerated."
                : "Your preview has already been submitted. It will appear in Submitted Previews while DOCX, Excel, and Images files are generated."}
            </p>
          </div>
        </div>
      )}

      {previewData?.is_merged_report && (
        <div
          className={`mb-4 border p-4 ${
            duplicateLotNumberKeys.size > 0
              ? "border-[var(--app-warning-border)] bg-[var(--app-warning-soft)]"
              : "border-[var(--app-info-border)] bg-[var(--app-info-soft)]"
          }`}
        >
          <div className="flex items-start gap-3">
            <MergeIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--app-info)]" />
            <div>
              <p className="font-semibold text-[var(--app-text-strong)]">
                Merged from {Array.isArray(previewData?.merged_from_report_ids) ? previewData.merged_from_report_ids.length : 2} Asset reports
              </p>
              {duplicateLotNumberKeys.size > 0 ? (
                <p className="mt-1 text-sm text-[var(--app-warning)]">
                  Duplicate lot numbers {Array.from(duplicateLotNumberKeys).join(", ")} must be changed before this report can be submitted.
                </p>
              ) : (
                <p className="mt-1 text-sm text-[var(--app-info)]">
                  Source reports remain unchanged. Review the combined lots before submission.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {specPdfUrl && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3 shadow-sm">
          <div className="mr-auto">
            <p className="text-sm font-semibold text-[var(--app-text-strong)]">CR</p>
          </div>
          <button
            type="button"
            onClick={handlePrintSpecPdf}
            className="app-button app-button--secondary"
          >
            <Printer className="h-4 w-4" />
            Print
          </button>
          <button
            type="button"
            onClick={() => void handleDownloadSpecPdf()}
            className="app-button app-button--primary"
          >
            <Download className="h-4 w-4" />
            Download CR
          </button>
          <button
            type="button"
            onClick={() => void handleDownloadCrDocx()}
            className="app-button app-button--secondary"
            title={crDocxUrl ? "Download editable CR Word file" : "Generate and download editable CR Word file"}
          >
            <Download className="h-4 w-4" />
            CR DOCX
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--app-accent)] border-t-transparent"></div>
        </div>
      ) : (
        <>
          <datalist id="asset-auctioneer-categories">
            {categorySpecs.map((spec) => (
              <option key={spec.childCategory} value={spec.childCategory} />
            ))}
          </datalist>
          {/* Report Details */}
          <div className="space-y-4 max-w-none pb-24">
            {/* Basic Information Section */}
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
              <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                <span className="text-[var(--app-accent)]">👤</span>
                Basic Information
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Client Name *
                  </label>
                  <input
                    type="text"
                    {...getFocusTrackingProps("client_name")}
                    value={previewData?.client_name || ""}
                    onChange={(e) => updateField("client_name", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                    placeholder="e.g., ABC Corporation"
                  />
                  {!previewData?.client_name && (
                    <p className="mt-1 text-xs text-[var(--app-warning)]">⚠️ Required field</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Owner Name
                  </label>
                  <input
                    type="text"
                    {...getFocusTrackingProps("owner_name")}
                    value={previewData?.owner_name || ""}
                    onChange={(e) => updateField("owner_name", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                    placeholder="e.g., John Smith"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Contract Number
                  </label>
                  <input
                    type="text"
                    {...getFocusTrackingProps("contract_no")}
                    value={previewData?.contract_no || ""}
                    onChange={(e) => updateField("contract_no", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                    placeholder="e.g., C-2024-001"
                  />
                </div>
                <div className="sm:col-span-2 lg:col-span-3">
                  <label
                    htmlFor="asset-preview-inspection-location"
                    className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5"
                  >
                    Inspection Location *
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      id="asset-preview-inspection-location"
                      type="text"
                      {...getFocusTrackingProps("location")}
                      value={previewData?.location || ""}
                      onChange={(event) => updateLocation(event.target.value)}
                      aria-describedby="asset-preview-location-status"
                      aria-invalid={!isLocationReady}
                      className="min-w-0 flex-1 px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                      placeholder="Street address, city, province/state, country"
                    />
                    <button
                      type="button"
                      onClick={requestCurrentLocation}
                      disabled={locationBusy}
                      className="app-button app-button--secondary shrink-0"
                    >
                      {locationBusy ? (
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      ) : null}
                      {locationBusy ? "Resolving location…" : "Use current location"}
                    </button>
                  </div>
                  <p
                    id="asset-preview-location-status"
                    className={`mt-1.5 text-xs ${
                      isLocationReady
                        ? "text-[var(--app-text-muted)]"
                        : "text-[var(--app-warning)]"
                    }`}
                    aria-live="polite"
                  >
                    {locationStatus}
                    {locationAttribution ? (
                      <>
                        {" · "}
                        <a
                          href={locationAttributionUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-2"
                        >
                          {locationAttribution}
                        </a>
                      </>
                    ) : null}
                  </p>
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Bank
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      updateField("bank_photos_enabled", !previewData?.bank_photos_enabled)
                    }
                    className={`app-button w-full justify-between ${
                      previewData?.bank_photos_enabled
                        ? "app-button--primary"
                        : "app-button--secondary"
                    }`}
                    aria-pressed={!!previewData?.bank_photos_enabled}
                  >
                    <span>Include all photos in CR</span>
                    <span className="rounded-full bg-[var(--app-panel)] px-2 py-0.5 text-xs text-[var(--app-accent)] shadow-sm">
                      {previewData?.bank_photos_enabled ? "On" : "Off"}
                    </span>
                  </button>
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Industry
                  </label>
                  <input
                    type="text"
                    {...getFocusTrackingProps("industry")}
                    value={previewData?.industry || ""}
                    onChange={(e) => updateField("industry", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                    placeholder="e.g., Construction, Manufacturing"
                  />
                </div>
              </div>
            </div>

            {/* Dates & Financial Section */}
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
              <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                <span className="text-[var(--app-success)]">📅</span>
                Dates & Financial
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Effective Date
                  </label>
                  <input
                    type="date"
                    {...getFocusTrackingProps("effective_date")}
                    value={previewData?.effective_date?.split("T")[0] || ""}
                    onChange={(e) => updateField("effective_date", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Inspection Date
                  </label>
                  <input
                    type="date"
                    {...getFocusTrackingProps("inspection_date")}
                    value={previewData?.inspection_date?.split("T")[0] || ""}
                    onChange={(e) => updateField("inspection_date", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Currency
                  </label>
                  <select
                    {...getFocusTrackingProps("currency")}
                    value={previewData?.currency || "CAD"}
                    onChange={(e) => handleCurrencyChange(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                  >
                    <option value="CAD">CAD - Canadian Dollar</option>
                    <option value="USD">USD - US Dollar</option>
                    <option value="EUR">EUR - Euro</option>
                    <option value="GBP">GBP - British Pound</option>
                    <option value="INR">INR - Indian Rupee</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Total Appraised Value
                  </label>
                  <input
                    type="text"
                    {...getFocusTrackingProps("total_appraised_value")}
                    value={previewData?.total_appraised_value || previewData?.total_value || ""}
                    onChange={(e) => updateField("total_appraised_value", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                    placeholder="e.g., $100,000 or CAD 100,000"
                  />
                </div>
              </div>
            </div>

            {/* Appraisal Details Section */}
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
              <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                <span className="text-[var(--app-info)]">📋</span>
                Appraisal Details
              </h3>
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Appraisal Purpose
                  </label>
                  <input
                    type="text"
                    {...getFocusTrackingProps("appraisal_purpose")}
                    value={previewData?.appraisal_purpose || ""}
                    onChange={(e) => updateField("appraisal_purpose", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                    placeholder="e.g., Insurance, Sale, Financing, Internal Review"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                      Appraiser Name
                    </label>
                    <input
                      type="text"
                      {...getFocusTrackingProps("appraiser")}
                      value={previewData?.appraiser || ""}
                      onChange={(e) => updateField("appraiser", e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                      placeholder="e.g., John Appraiser, CPA"
                    />
                  </div>
                  <div>
                    <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                      Appraisal Company
                    </label>
                    <input
                      type="text"
                      {...getFocusTrackingProps("appraisal_company")}
                      value={previewData?.appraisal_company || ""}
                      onChange={(e) => updateField("appraisal_company", e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                      placeholder="e.g., Asset Insight Appraisals"
                    />
                  </div>
                  <div className="sm:col-span-2 lg:col-span-3">
                    <AppraiserSignaturePad
                      value={previewData?.appraiser_signature_data_url || ""}
                      disabled={workflowLocked}
                      onChange={updateAppraiserSignature}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Additional Report Details */}
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
              <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                <span className="text-[var(--app-warning)]">📝</span>
                Additional Details
              </h3>
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Prepared For
                  </label>
                  <input
                    type="text"
                    {...getFocusTrackingProps("prepared_for")}
                    value={previewData?.prepared_for || ""}
                    onChange={(e) => updateField("prepared_for", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                    placeholder="e.g., Client Contact / Company"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Factors Affecting Value - Age & Condition
                  </label>
                  <textarea
                    {...getFocusTrackingProps("factors_age_condition")}
                    value={previewData?.factors_age_condition || ""}
                    onChange={(e) => updateField("factors_age_condition", e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                    placeholder="Describe age and condition..."
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Factors Affecting Value - Quality
                  </label>
                  <textarea
                    {...getFocusTrackingProps("factors_quality")}
                    value={previewData?.factors_quality || ""}
                    onChange={(e) => updateField("factors_quality", e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                    placeholder="Describe quality..."
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Factors Affecting Value - Analysis
                  </label>
                  <textarea
                    {...getFocusTrackingProps("factors_analysis")}
                    value={previewData?.factors_analysis || ""}
                    onChange={(e) => updateField("factors_analysis", e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all"
                    placeholder="Provide overall analysis..."
                  />
                </div>
              </div>
            </div>

            {/* Software narrative fields removed to match DOCX inputs */}

            {/* Quick Stats */}
            <div className="rounded-xl border border-[var(--app-info-border)] bg-[var(--app-info-soft)] p-4">
              <h4 className="text-sm font-bold text-[var(--app-text)] mb-3">📊 Report Statistics</h4>
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                <div className="text-center">
                  <div className="text-2xl font-bold text-[var(--app-accent)]">{previewData?.lots?.length || 0}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Total Lots</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-[var(--app-success)]">{previewData?.currency || "CAD"}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Currency</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-[var(--app-info)]">{previewData?.language?.toUpperCase() || "EN"}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Language</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-[var(--app-accent)]">{previewData?.total_appraised_value ? "✓" : "-"}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Value Set</div>
                </div>
                <div className="text-center">
                  <div className="text-sm font-semibold text-[var(--app-accent)]">{(groupingMode || previewData?.grouping_mode || "mixed").toString()}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Grouping</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-[var(--app-info)]">{imageCount ?? "-"}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Images</div>
                </div>
              </div>
            </div>

            <AssetCoverImagePicker
              candidateUrls={coverImageCandidates}
              value={selectedCoverImageUrls}
              onChange={(urls) => updateField("cover_image_urls", urls)}
              disabled={workflowLocked || submitting}
            />


          </div>

          {/* Lot photo viewer: a floating window that can be moved, resized,
              minimized and maximized; Left/Right arrows step through photos. */}
          {galleryLotImages !== null && (
            <FloatingPhotoViewer
              title={(() => {
                const lotIndex = galleryLotImages.entries[0]?.lotIndex ?? 0;
                return `Lot ${getLotDisplayNumber(lotsArray[lotIndex], lotIndex)}`;
              })()}
              entries={galleryLotImages.entries.map((entry) => ({
                url: entry.url,
                key: `${entry.globalIndex ?? "url"}-${entry.url}`,
              }))}
              index={galleryLotImages.currentIdx}
              onIndexChange={(currentIdx) =>
                setGalleryLotImages((prev) => (prev ? { ...prev, currentIdx } : null))
              }
              onClose={() => setGalleryLotImages(null)}
            />
          )}

          {/* Assets/Lots */}
          <div className="mt-6 space-y-4 max-w-none">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)]">Assets / Lots</h3>
              <button
                type="button"
                onClick={addLot}
                className="app-button app-button--primary"
              >
                Add Lot
              </button>
            </div>
            <p className="text-sm text-[var(--app-text-muted)]">The Title is used as the Description in generated Excel and condition report files.</p>
            {renderBulkConditionSelection()}
            <div ref={lotPageStartRef} role="group" tabIndex={-1} aria-label={`Lot page ${activeLotPage} of ${lotPageCount}`} className="scroll-mt-4 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]">
              {renderLotPagination("top")}
            </div>
            {groupedLots.length ? (
              <>
                {/* Pagination already bounds this list. Content-visibility placeholders
                    shift the bottom pager during scrolling and can misdirect clicks. */}
                {/* Mobile: card list grouped by sub-mode */}
                {!isDesktopLayout ? <div className="space-y-5">
                  {groupedLots.map((group) => (
                    <div key={group.gid}>
                      <div className="mb-2 text-sm font-semibold text-[var(--app-text)]">
                        Group {group.gid || 1} — {labelForSubMode(group.subMode)} ({group.items.length}{lotPageCount > 1 ? " on this page" : ""})
                      </div>
                      <div className="space-y-3">
                        {group.items.map(({ lot, idx }) => {
                          const lotLabel = getLotDisplayNumber(lot, idx);
                          const valuationLines = buildLotValuationLines(
                            lot.estimated_value,
                            previewData?.valuation_methods,
                            previewData?.valuation_data?.methods
                          );
                          return (
                          <div
                            key={idx}
                            className={`rounded-[1.25rem] border bg-[var(--app-panel-soft)] p-3 shadow-sm transition-colors ${
                              validSelectedLotIndexes.has(idx)
                                ? "border-[var(--app-accent)]"
                                : "border-[var(--app-border)]"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                {renderLotSelectionCheckbox(lot, idx, "mobile")}
                                <div className="text-sm font-semibold text-[var(--app-text)]">Lot {getLotDisplayNumber(lot, idx)}</div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => deleteLot(idx)}
                                  aria-label={`Delete lot ${idx + 1}`}
                                  className="app-button app-button--danger !min-h-7 !rounded-md !px-2 !py-1 !text-xs"
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                            {/* Lot Images */}
                            {(() => {
                              const lotImages = getLotPhotoEntries(lot);
                              const lotUploadKey = getLotUploadKey(lot, idx);
                              const uploadInputId = `asset-preview-upload-${idx}-mobile`;
                              const openLotGallery = (startIdx: number) => {
                                setGalleryLotImages({
                                  entries: lotImages.map((entry) => ({ ...entry, lotIndex: idx })),
                                  currentIdx: startIdx,
                                });
                              };
                              return (
                                <div className="mb-3">
                                  <div className="mb-1.5 flex items-center justify-between gap-2">
                                    <label className="flex items-center gap-2 text-xs text-[var(--app-text-muted)]">
                                      <Image className="h-3.5 w-3.5" />
                                      Photos ({lotImages.length})
                                    </label>
                                    <input
                                      id={uploadInputId}
                                      type="file"
                                      accept="image/*"
                                      multiple
                                      disabled={activeMutation !== null || workflowLocked}
                                      className="hidden"
                                      onChange={(event) => {
                                        handleUploadLotImages(lot, idx, event.target.files);
                                        event.currentTarget.value = "";
                                      }}
                                    />
                                    <button
                                      type="button"
                                      disabled={activeMutation !== null || workflowLocked}
                                      onClick={() => document.getElementById(uploadInputId)?.click()}
                                      className="app-button app-button--secondary !min-h-7 !rounded-md !px-2.5 !py-1 !text-[11px]"
                                    >
                                      <Upload className="h-3 w-3" />
                                      {uploadingLotKey === lotUploadKey ? "Uploading" : "Upload images"}
                                    </button>
                                  </div>
                                  {lotImages.length > 0 && (
                                  <div className="relative">
                                    <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-gray-100">
                                      {lotImages.slice(0, 20).map(({ url, globalIndex }, imgIdx) => (
                                        <div
                                          key={imgIdx}
                                          className="group relative flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden border border-[var(--app-border)] cursor-pointer hover:border-[var(--app-accent)] hover:shadow-md transition-all"
                                          onClick={() => openLotGallery(imgIdx)}
                                        >
                                          { }
                                          <img
                                            src={url}
                                            alt={`Photo ${imgIdx + 1}`}
                                            loading="lazy"
                                            decoding="async"
                                            className="h-full w-full object-cover"
                                          />
                                          <button
                                            type="button"
                                            onClick={(event) => {
                                              event.preventDefault();
                                              event.stopPropagation();
                                              deleteLotImage(idx, { globalIndex, url });
                                            }}
                                            className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-[var(--app-danger)] text-xs font-black text-white opacity-95 shadow"
                                            aria-label={`Remove photo ${imgIdx + 1}`}
                                          >
                                            x
                                          </button>
                                        </div>
                                      ))}
                                      {lotImages.length > 20 && (
                                        <button
                                          type="button"
                                          className="flex h-20 w-20 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] transition-colors hover:border-[var(--app-accent)] hover:bg-[var(--app-accent-soft)] hover:text-[var(--app-accent)]"
                                          onClick={() => openLotGallery(20)}
                                          aria-label={`Open ${lotImages.length - 20} more photos`}
                                        >
                                          <span className="text-sm font-semibold text-[var(--app-text-muted)]">+{lotImages.length - 20}</span>
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  )}
                                </div>
                              );
                            })()}
                            <div className="space-y-2">
                              <div>
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <label className="block text-xs text-[var(--app-text-muted)]">Lot #</label>
                                  {renderFieldEditorButton(idx, "lot_number", "mobile")}
                                </div>
                                <input
                                  type="text"
                                  {...getFocusTrackingProps(`lot-${idx}-lot-number-mobile`)}
                                  value={String(lot.lot_number ?? getLotDisplayNumber(lot, idx))}
                                  onChange={(e) => updateLot(idx, "lot_number", e.target.value)}
                                  className={`w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm ${
                                    isDuplicateLotNumber(lot, idx)
                                      ? "border-[var(--app-warning)] bg-[var(--app-warning-soft)]"
                                      : "border-[var(--app-border)]"
                                  }`}
                                  placeholder={String(idx + 1)}
                                />
                              </div>
                              <div>
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <label className="block text-xs text-[var(--app-text-muted)]">Title</label>
                                  {renderFieldEditorButton(idx, "title", "mobile")}
                                </div>
                                <input
                                  type="text"
                                  {...getFocusTrackingProps(`lot-${idx}-title-mobile`)}
                                  value={lot.title || ""}
                                  onChange={(e) => updateLot(idx, "title", e.target.value)}
                                  className="w-full px-3 py-2 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm"
                                  placeholder="Title"
                                />
                              </div>
                              <div>
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <label className="block text-xs text-[var(--app-text-muted)]">Category</label>
                                  {renderFieldEditorButton(idx, "categories", "mobile")}
                                </div>
                                <input
                                  type="text"
                                  list="asset-auctioneer-categories"
                                  {...getFocusTrackingProps(`lot-${idx}-category-mobile`)}
                                  value={lot.categories || ""}
                                  onChange={(e) => updateLot(idx, "categories", e.target.value)}
                                  className="w-full px-3 py-2 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm"
                                  placeholder="Auctioneer Import category"
                                />
                              </div>
                              {renderConditionSelections(lot, idx, "mobile")}
                              <AuctioneerSpecsEditor
                                lot={lot}
                                lotIndex={idx}
                                specsByCategory={specsByCategory}
                                onChange={updateLotSpec}
                                onAdd={addLotSpec}
                                onDelete={deleteLotSpec}
                                includeDamageAnalysis={includeDamageAnalysis}
                                damageEligible={isDamageAnalysisEligibleForLot(
                                  getLotNumberForDamagePolicy(lot)
                                )}
                                damageAnalysis={lot.damage_analysis}
                                onDamageAnalysisChange={(lotIndex, value) =>
                                  updateLot(lotIndex, "damage_analysis", value)
                                }
                                accent="rose"
                              />
                              <div>
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <label className="block text-xs text-[var(--app-text-muted)]">Base market value</label>
                                  {renderFieldEditorButton(idx, "estimated_value", "mobile")}
                                </div>
                                <input
                                  type="text"
                                  aria-label={`Base market value for lot ${lotLabel}`}
                                  {...getFocusTrackingProps(`lot-${idx}-estimated_value-mobile`)}
                                  value={lot.estimated_value || ""}
                                  onChange={(e) => updateLot(idx, "estimated_value", e.target.value)}
                                  className="w-full px-3 py-2 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm"
                                  placeholder="e.g., $25,000"
                                />
                                <div className="mt-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
                                  <p className="mb-2 text-xs font-bold text-[var(--app-text)]">Selected valuation methods</p>
                                  <SelectedValuationMethods lines={valuationLines} lotLabel={lotLabel} />
                                  <LotValuationValues
                                    lines={valuationLines}
                                    currency={previewData?.currency || "CAD"}
                                    lotLabel={lotLabel}
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div> : null}

                {/* Desktop: table per group */}
                {isDesktopLayout ? <div className="space-y-6">
                  {groupedLots.map((group) => (
                    <div key={group.gid} className="overflow-x-auto rounded-lg">
                      <div className="mb-2 text-sm font-semibold text-[var(--app-text)]">
                        Group {group.gid || 1} — {labelForSubMode(group.subMode)} ({group.items.length}{lotPageCount > 1 ? " on this page" : ""})
                      </div>
                      <table className="w-full min-w-[1280px] table-fixed text-sm border border-[var(--app-border)] rounded-lg overflow-hidden">
                        <thead className="bg-[var(--app-panel-alt)] text-[var(--app-text-muted)]">
                          <tr>
                            <th className="w-[7%] px-2 py-2 text-left">Lot #</th>
                            <th className="w-[16%] px-2 py-2 text-left">Photos</th>
                            <th className="w-[21%] px-2 py-2 text-left">Title</th>
                            <th className="w-[16%] px-2 py-2 text-left">Category</th>
                            <th className="w-[16%] px-2 py-2 text-left">Selections / valuations</th>
                            <th className="w-[18%] px-2 py-2 text-left">Value</th>
                            <th className="w-[6%] px-2 py-2 text-left">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.items.map(({ lot, idx }, i) => {
                            const lotImages = getLotPhotoEntries(lot);
                            const lotLabel = getLotDisplayNumber(lot, idx);
                            const valuationLines = buildLotValuationLines(
                              lot.estimated_value,
                              previewData?.valuation_methods,
                              previewData?.valuation_data?.methods
                            );
                            const lotUploadKey = getLotUploadKey(lot, idx);
                            const uploadInputId = `asset-preview-upload-${idx}-desktop`;
                            const openLotGallery = (startIdx: number) => {
                              setGalleryLotImages({
                                entries: lotImages.map((entry) => ({ ...entry, lotIndex: idx })),
                                currentIdx: startIdx,
                              });
                            };
                            return (
                            <React.Fragment key={idx}>
                            <tr
                              className={
                                validSelectedLotIndexes.has(idx)
                                  ? "bg-[var(--app-accent-soft)]"
                                  : i % 2 === 0
                                    ? "bg-[var(--app-panel)]"
                                    : "bg-[var(--app-panel-alt)]"
                              }
                            >
                              <td className="px-2 py-2 text-[var(--app-text)] font-medium align-top">
                                <div className="mb-1">
                                  {renderLotSelectionCheckbox(lot, idx, "desktop")}
                                </div>
                                <input
                                  type="text"
                                  {...getFocusTrackingProps(`lot-${idx}-lot-number-desktop`)}
                                  value={String(lot.lot_number ?? getLotDisplayNumber(lot, idx))}
                                  onChange={(e) => updateLot(idx, "lot_number", e.target.value)}
                                  className={`w-full min-w-0 px-2 py-1.5 border rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm font-semibold ${
                                    isDuplicateLotNumber(lot, idx)
                                      ? "border-[var(--app-warning)] bg-[var(--app-warning-soft)]"
                                      : "border-[var(--app-border)]"
                                  }`}
                                  placeholder={String(idx + 1)}
                                />
                                <div className="mt-1">{renderFieldEditorButton(idx, "lot_number", "desktop")}</div>
                              </td>
                              <td className="px-2 py-2 align-top">
                                <input
                                  id={uploadInputId}
                                  type="file"
                                  accept="image/*"
                                  multiple
                                  disabled={activeMutation !== null || workflowLocked}
                                  className="hidden"
                                  onChange={(event) => {
                                    handleUploadLotImages(lot, idx, event.target.files);
                                    event.currentTarget.value = "";
                                  }}
                                />
                                {lotImages.length > 0 ? (
                                  <div className="space-y-1">
                                    <div className="flex gap-1.5 flex-wrap">
                                      {lotImages.slice(0, 6).map(({ url, globalIndex }, imgI) => (
                                        <div
                                          key={imgI}
                                          className="relative w-14 h-14 rounded-lg overflow-hidden border border-[var(--app-border)] cursor-pointer hover:border-[var(--app-accent)] hover:shadow-md transition-all flex-shrink-0"
                                          onClick={() => openLotGallery(imgI)}
                                        >
                                          { }
                                          <img
                                            src={url}
                                            alt={`Photo ${imgI + 1}`}
                                            loading="lazy"
                                            decoding="async"
                                            className="h-full w-full object-cover"
                                          />
                                          <button
                                            type="button"
                                            onClick={(event) => {
                                              event.preventDefault();
                                              event.stopPropagation();
                                              deleteLotImage(idx, { globalIndex, url });
                                            }}
                                            className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-[var(--app-danger)] text-[10px] font-black text-white shadow"
                                            aria-label={`Remove photo ${imgI + 1}`}
                                          >
                                            x
                                          </button>
                                        </div>
                                      ))}
                                      {lotImages.length > 6 && (
                                        <button
                                          type="button"
                                          className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] transition-colors hover:border-[var(--app-accent)] hover:bg-[var(--app-accent-soft)] hover:text-[var(--app-accent)]"
                                          onClick={() => openLotGallery(6)}
                                          aria-label={`Open ${lotImages.length - 6} more photos`}
                                        >
                                          <span className="text-xs font-bold text-[var(--app-text-muted)]">+{lotImages.length - 6}</span>
                                        </button>
                                      )}
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="text-[10px] text-[var(--app-text-muted)]">{lotImages.length} photo{lotImages.length !== 1 ? 's' : ''}</span>
                                      <button
                                        type="button"
                                        disabled={activeMutation !== null || workflowLocked}
                                        onClick={() => document.getElementById(uploadInputId)?.click()}
                                        className="app-button app-button--secondary !min-h-7 !rounded-md !px-2 !py-1 !text-[10px]"
                                      >
                                        <Upload className="h-3 w-3" />
                                        {uploadingLotKey === lotUploadKey ? "Uploading" : "Upload"}
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={activeMutation !== null || workflowLocked}
                                    onClick={() => document.getElementById(uploadInputId)?.click()}
                                    className="app-button app-button--secondary !min-h-8 !rounded-md !px-3 !py-1.5 !text-xs"
                                  >
                                    <Upload className="h-3.5 w-3.5" />
                                    {uploadingLotKey === lotUploadKey ? "Uploading" : "Upload images"}
                                  </button>
                                )}
                              </td>
                              <td className="px-2 py-2 align-top">
                                <input
                                  type="text"
                                  {...getFocusTrackingProps(`lot-${idx}-title-desktop`)}
                                  value={lot.title || ""}
                                  onChange={(e) => updateLot(idx, "title", e.target.value)}
                                  className="w-full px-2 py-1.5 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm"
                                  placeholder="Title"
                                />
                                <div className="mt-1">{renderFieldEditorButton(idx, "title", "desktop")}</div>
                              </td>
                              <td className="px-2 py-2 align-top">
                                <input
                                  type="text"
                                  list="asset-auctioneer-categories"
                                  {...getFocusTrackingProps(`lot-${idx}-category-desktop`)}
                                  value={lot.categories || ""}
                                  onChange={(e) => updateLot(idx, "categories", e.target.value)}
                                  className="w-full px-2 py-1.5 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm"
                                  placeholder="Category"
                                />
                                <div className="mt-1">{renderFieldEditorButton(idx, "categories", "desktop")}</div>
                              </td>
                              <td className="px-2 py-2 align-top">
                                {renderConditionSelections(lot, idx, "desktop")}
                                <div className="mt-2">
                                <SelectedValuationMethods lines={valuationLines} lotLabel={lotLabel} />
                                </div>
                              </td>
                              <td className="px-2 py-2 align-top">
                                <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-[var(--app-text-muted)]">
                                  Base FMV
                                </label>
                                <input
                                  type="text"
                                  aria-label={`Base market value for lot ${lotLabel}`}
                                  {...getFocusTrackingProps(`lot-${idx}-estimated_value-desktop`)}
                                  value={lot.estimated_value || ""}
                                  onChange={(e) => updateLot(idx, "estimated_value", e.target.value)}
                                  className="w-full px-2 py-1.5 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm"
                                  placeholder="e.g., $25,000"
                                />
                                <div className="mt-1">{renderFieldEditorButton(idx, "estimated_value", "desktop")}</div>
                                <LotValuationValues
                                  lines={valuationLines}
                                  currency={previewData?.currency || "CAD"}
                                  lotLabel={lotLabel}
                                />
                              </td>
                              <td className="px-2 py-2 align-top">
                                <div className="flex flex-col items-stretch gap-1.5">
                                  <button
                                    onClick={() => deleteLot(idx)}
                                    aria-label={`Delete lot ${idx + 1}`}
                                    className="app-button app-button--danger !min-h-8 !rounded-md !px-2.5 !py-1.5 !text-xs"
                                  >
                                    Delete
                                  </button>
                                </div>
                              </td>
                            </tr>
                            <tr className={i % 2 === 0 ? "bg-[var(--app-panel)]" : "bg-[var(--app-panel-alt)]"}>
                              <td colSpan={7} className="px-3 pb-4">
                                <AuctioneerSpecsEditor
                                  lot={lot}
                                  lotIndex={idx}
                                  specsByCategory={specsByCategory}
                                  onChange={updateLotSpec}
                                  onAdd={addLotSpec}
                                  onDelete={deleteLotSpec}
                                  includeDamageAnalysis={includeDamageAnalysis}
                                  damageEligible={isDamageAnalysisEligibleForLot(
                                    getLotNumberForDamagePolicy(lot)
                                  )}
                                  damageAnalysis={lot.damage_analysis}
                                  onDamageAnalysisChange={(lotIndex, value) =>
                                    updateLot(lotIndex, "damage_analysis", value)
                                  }
                                  accent="rose"
                                />
                              </td>
                            </tr>
                            </React.Fragment>
                          );})}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div> : null}
              </>
            ) : (
              <div className="text-center py-16 bg-[var(--app-panel-alt)] rounded-xl border border-dashed border-[var(--app-border)]">
                <div className="text-6xl mb-4">📦</div>
                <p className="text-[var(--app-text-muted)] font-medium">No lots data available</p>
                <p className="text-sm text-[var(--app-text-muted)] mt-1">Software analysis didn't extract any lot information</p>
              </div>
            )}
            {renderLotPagination("bottom")}
          </div>

          {/* Valuation */}
          <div className="mt-6 space-y-4 max-w-none">
            <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)]">Valuation</h3>
            <div className="flex items-center gap-3 p-3 border border-[var(--app-border)] rounded-lg bg-[var(--app-panel-alt)]">
              <input
                id="include-valuation"
                type="checkbox"
                checked={!!previewData?.include_valuation_table}
                onChange={(e) => updateField("include_valuation_table", e.target.checked)}
                className="h-4 w-4"
              />
              <label htmlFor="include-valuation" className="text-sm text-[var(--app-text)]">Include Valuation Comparison Table</label>
            </div>
            {previewData?.include_valuation_table ? (
              <>
                <div className="rounded-lg border border-[var(--app-info-border)] bg-[var(--app-info-soft)] p-4">
                  <h4 className="mb-2 font-semibold text-[var(--app-text-strong)]">
                    Valuation Methods Selected
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {previewData?.valuation_methods?.map((method: string) => (
                      <span
                        key={method}
                        className="rounded-full border border-[var(--app-info-border)] bg-[var(--app-panel)] px-3 py-1 text-sm font-medium text-[var(--app-info)]"
                      >
                        {method}
                      </span>
                    ))}
                  </div>
                </div>
                {previewData?.valuation_data && (
                  <div className="p-4 border border-[var(--app-border)] rounded-lg">
                    <h4 className="font-semibold text-[var(--app-text)] mb-2">
                      Base Fair Market Value
                    </h4>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-[var(--app-text-muted)]">{previewData?.currency || "CAD"}</span>
                      <input
                        type="number"
                        min={0}
                        {...getFocusTrackingProps("valuation-baseFMV")}
                        value={Number(previewData.valuation_data.baseFMV || 0)}
                        onChange={(e) => updateValuationBase(Number(e.target.value))}
                        className="w-56 px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent transition-all tabular-nums"
                      />
                    </div>
                  </div>
                )}
                {Array.isArray(previewData?.valuation_data?.methods) && previewData.valuation_data.methods.length > 0 && (
                  <div className="p-4 border border-[var(--app-border)] rounded-lg">
                    <h4 className="font-semibold text-[var(--app-text)] mb-3">Comparison Table</h4>
                    <div className="overflow-x-auto">
                      <table className="min-w-full table-fixed text-sm border border-[var(--app-border)] rounded-md overflow-hidden">
                        <thead className="bg-[var(--app-panel-alt)] text-[var(--app-text-muted)]">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium w-[26%]">Method</th>
                            <th className="px-3 py-2 text-left font-medium w-[16%]">Value</th>
                            <th className="px-3 py-2 text-left font-medium w-[24%]">Conditions</th>
                            <th className="px-3 py-2 text-left font-medium w-[18%]">Timeline</th>
                            <th className="px-3 py-2 text-left font-medium w-[16%]">Use Case</th>
                          </tr>
                        </thead>
                        <tbody>
                          {previewData.valuation_data.methods.map((m: any, i: number) => (
                            <tr key={i} className={i % 2 === 0 ? "bg-[var(--app-panel)]" : "bg-[var(--app-panel-alt)]"}>
                              <td className="px-3 py-2 align-top">
                                <div className="mb-1">
                                  <input
                                    type="text"
                                    {...getFocusTrackingProps(`valuation-${i}-fullName`)}
                                    value={m.fullName || ""}
                                    onChange={(e) => updateValuationMethod(i, "fullName", e.target.value)}
                                    className="w-full px-2 py-1.5 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm"
                                    placeholder="Full method name"
                                  />
                                </div>
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="inline-flex items-center rounded-md border border-[var(--app-info-border)] bg-[var(--app-info-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--app-info)]">{m.method || "—"}</span>
                                  <span className="text-[11px] text-[var(--app-text-muted)]">Code</span>
                                </div>
                                <textarea
                                  {...getFocusTrackingProps(`valuation-${i}-description`)}
                                  value={m.description || ""}
                                  onChange={(e) => updateValuationMethod(i, "description", e.target.value)}
                                  className="mt-1 w-full px-2 py-1.5 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-xs leading-5 resize-none min-h-[56px]"
                                  placeholder="Short description"
                                  rows={2}
                                />
                              </td>
                              <td className="px-3 py-2 align-top">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-[var(--app-text-muted)]">{previewData?.currency || 'CAD'}</span>
                                  <input
                                    type="number"
                                    min={0}
                                    {...getFocusTrackingProps(`valuation-${i}-value`)}
                                    value={Number(m.value || 0)}
                                    onChange={(e) => updateValuationMethod(i, "value", Number(e.target.value))}
                                    className="w-44 px-2 py-1.5 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm tabular-nums"
                                  />
                                </div>
                              </td>
                              <td className="px-3 py-2 align-top">
                                <textarea
                                  {...getFocusTrackingProps(`valuation-${i}-saleConditions`)}
                                  value={m.saleConditions || ""}
                                  onChange={(e) => updateValuationMethod(i, "saleConditions", e.target.value)}
                                  className="w-full px-2 py-1.5 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-xs leading-5 resize-none min-h-[56px]"
                                  placeholder="Conditions"
                                  rows={2}
                                />
                              </td>
                              <td className="px-3 py-2 align-top">
                                <input
                                  type="text"
                                  {...getFocusTrackingProps(`valuation-${i}-timeline`)}
                                  value={m.timeline || ""}
                                  onChange={(e) => updateValuationMethod(i, "timeline", e.target.value)}
                                  className="w-full px-2 py-1.5 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm"
                                  placeholder="Timeline"
                                />
                              </td>
                              <td className="px-3 py-2 align-top">
                                <input
                                  type="text"
                                  {...getFocusTrackingProps(`valuation-${i}-useCase`)}
                                  value={m.useCase || ""}
                                  onChange={(e) => updateValuationMethod(i, "useCase", e.target.value)}
                                  className="w-full px-2 py-1.5 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-[var(--app-accent)] focus:border-transparent text-sm"
                                  placeholder="Use Case"
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-12 text-[var(--app-text-muted)]">
                No valuation data selected for this report
              </div>
            )}
          </div>

          {/* Summary */}
          <div className="mt-6 space-y-6 max-w-none">
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] p-6 shadow-sm">
              <h3 className="text-lg font-bold text-[var(--app-text)] mb-4">
                Report Summary
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-[var(--app-text-muted)]">Client</p>
                  <p className="font-semibold text-[var(--app-text)]">
                    {previewData?.client_name || "Not specified"}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-[var(--app-text-muted)]">Owner</p>
                  <p className="font-semibold text-[var(--app-text)]">
                    {previewData?.owner_name || "Not specified"}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-[var(--app-text-muted)]">Effective Date</p>
                  <p className="font-semibold text-[var(--app-text)]">
                    {previewData?.effective_date?.split("T")[0] || "Not set"}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-[var(--app-text-muted)]">Inspection Date</p>
                  <p className="font-semibold text-[var(--app-text)]">
                    {previewData?.inspection_date?.split("T")[0] || "Not set"}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-[var(--app-text-muted)]">Industry</p>
                  <p className="font-semibold text-[var(--app-text)]">
                    {previewData?.industry || "Not specified"}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-[var(--app-text-muted)]">Total Lots</p>
                  <p className="font-semibold text-[var(--app-text)]">
                    {previewData?.lots?.length || 0}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-[var(--app-text-muted)]">Currency</p>
                  <p className="font-semibold text-[var(--app-text)]">
                    {previewData?.currency || "CAD"}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-[1.25rem] border border-[var(--app-border)] bg-[rgba(148,163,184,0.08)] p-4">
              <h4 className="font-semibold text-[var(--app-text)] mb-2">Next Steps</h4>
              <ol className="list-decimal list-inside space-y-1 text-sm text-[var(--app-text-muted)]">
                <li>Review the data</li>
                <li>Make any necessary edits</li>
                <li>Save and generate files using the updated data</li>
              </ol>
            </div>
          </div>

          {expandedLotTextEditor && (() => {
            const { lotIndex, field } = expandedLotTextEditor;
            const lot = previewData?.lots?.[lotIndex];
            if (!lot) return null;

            const meta = lotTextFieldMeta[field];
            const lotNumber = getLotDisplayNumber(lot, lotIndex);

            return (
              <div
                className="fixed inset-0 z-[1000] flex items-center justify-center bg-[var(--app-overlay)] px-3 py-6 sm:px-6"
                onMouseDown={closeExpandedLotTextEditor}
              >
                <div
                  className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] shadow-sm"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <div className="flex items-start justify-between gap-4 border-b border-[var(--app-border)] px-4 py-3 sm:px-5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--app-text-muted)]">
                        Lot {lotNumber}
                      </p>
                      <h4 className="mt-0.5 text-lg font-bold text-[var(--app-text-strong)]">
                        {meta.label}
                      </h4>
                    </div>
                    <button
                      type="button"
                      onClick={closeExpandedLotTextEditor}
                      aria-label="Close editor"
                      className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-panel-alt)] text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-panel-alt)] hover:text-[var(--app-text)]"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="p-4 sm:p-5">
                    <textarea
                      {...getFocusTrackingProps(`expanded-lot-${lotIndex}-${field}`)}
                      autoFocus
                      value={lot[field] || ""}
                      onChange={(event) => updateLot(lotIndex, field, event.target.value)}
                      className="h-[52vh] min-h-[280px] w-full resize-none rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3 text-base leading-7 text-[var(--app-text)] shadow-inner outline-none transition-all placeholder:text-[var(--app-text-muted)] focus:border-transparent focus:ring-2 focus:ring-[var(--app-accent)]"
                      placeholder={meta.placeholder}
                    />
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Actions */}
          <div className="sticky bottom-0 z-10 mt-4 flex flex-col gap-2.5 border-t border-[var(--app-border)] bg-[var(--app-panel)] px-1 pt-3 pb-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            {lotPageCount > 1 && (
              <p className="order-first w-full text-xs text-[var(--app-text-muted)]">
                Saving generates files for all {lotsArray.length} lots across all {lotPageCount} pages, not only this page.
              </p>
            )}
            <button
              onClick={requestClose}
              disabled={activeMutation !== null}
              className="app-button order-2 text-[var(--app-text-muted)] sm:order-1"
            >
              Cancel
            </button>
            <div className="order-1 sm:order-2 flex flex-col sm:flex-row gap-2 sm:gap-3">
              {hasChanges && (
                <div className="hidden items-center gap-2 rounded-lg bg-[var(--app-warning-soft)] px-3 py-1 text-xs font-medium text-[var(--app-warning)] sm:flex">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Unsaved changes
                </div>
              )}
              <button
                onClick={handleSubmitForApproval}
                disabled={
                  editorLocked ||
                  loading ||
                  locationBusy ||
                  workflowLocked
                }
                className="app-button app-button--primary"
                aria-label={isAssignedApprovalMode ? "Save and approve preview" : "Save preview"}
                title={SAVE_PREVIEW_TITLE}
              >
                {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                <span>
                  {submitting
                    ? "Saving..."
                    : workflowLocked
                      ? "Generating files..."
                      : isAssignedApprovalMode
                        ? "Save & Approve"
                        : "Save"}
                </span>
              </button>
            </div>
          </div>
        </>
      )}
      </div>
      </div>
    </BottomDrawer>
  );
}
