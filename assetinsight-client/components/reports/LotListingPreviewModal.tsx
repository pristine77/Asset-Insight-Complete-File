"use client";

import React, { useEffect, useRef, useState } from "react";
import { Save, AlertCircle, Image, RefreshCw, Download, Printer, Upload } from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  getLotListingPreview,
  getLotListingSubmittedPreview,
  uploadLotListingPreviewLotImages,
  submitLotListingForApproval,
  resubmitLotListing,
  type LotListing,
  type LotListingLot,
} from "@/services/lotListing";
import { SAVE_PREVIEW_TITLE } from "@/lib/previewSave";
import { mergeSubmittedPreviewData } from "@/lib/previewSaveMerge";
import { getAssetCategorySpecs, type AssetCategorySpec } from "@/services/assets";
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
import { ReportDraftService } from "@/services/reportDrafts";
import { useExclusivePreviewMutation } from "@/components/reports/useExclusivePreviewMutation";

interface LotListingPreviewModalProps {
  reportId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (submittedReport?: any) => void;
  isResubmitMode?: boolean;
  isAssignedApprovalMode?: boolean;
  loadPreviewDataOverride?: (id: string) => Promise<any>;
  updatePreviewDataOverride?: (id: string, previewData: any) => Promise<any>;
  resubmitReportOverride?: (id: string, previewData?: any) => Promise<any>;
  uploadPreviewLotImagesOverride?: (
    id: string,
    lotKey: string | number,
    files: File[],
    previewData?: any,
    onProgress?: (progress: number) => void
  ) => Promise<any>;
  refreshSpecPdfOverride?: (id: string) => Promise<any>;
  draftPreviewId?: string;
}

type LotGalleryEntry = {
  url: string;
  globalIndex: number | null;
  lotIndex: number;
};

type LotGalleryState = {
  entries: LotGalleryEntry[];
  currentIdx: number;
};

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

const parseEstimatedValue = (value: unknown) => {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const calculateTotalValue = (lots: any[] | undefined | null) =>
  (Array.isArray(lots) ? lots : []).reduce(
    (sum, lot) => sum + parseEstimatedValue(lot?.estimated_value),
    0
  );

export default function LotListingPreviewModal({
  reportId,
  isOpen,
  onClose,
  onSuccess,
  isResubmitMode = false,
  isAssignedApprovalMode = false,
  loadPreviewDataOverride,
  resubmitReportOverride,
  uploadPreviewLotImagesOverride,
  draftPreviewId,
}: LotListingPreviewModalProps) {
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
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [uploadingLotKey, setUploadingLotKey] = useState<string | null>(null);
  const [previewFiles, setPreviewFiles] = useState<any>(null);
  const [categorySpecs, setCategorySpecs] = useState<AssetCategorySpec[]>([]);
  const [galleryLotImages, setGalleryLotImages] = useState<LotGalleryState | null>(null);
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
  const effectiveResubmitMode = status
    ? status === "pending_approval" || status === "approved" || status === "error"
    : isResubmitMode;
  const loadLotListingPreview = (id: string) =>
    loadPreviewDataOverride
      ? loadPreviewDataOverride(id)
      : isResubmitMode
        ? getLotListingSubmittedPreview(id)
        : getLotListingPreview(id);
  const editorLocked = activeMutation !== null;

  useEffect(() => {
    if (isOpen && reportId) {
      loadPreviewData();
    }
    return () => {
      loadRequestRef.current += 1;
    };
  }, [isOpen, reportId, isResubmitMode]);

  const applyLotListingState = (
    listing: any,
    options: { assumeFilesGenerating?: boolean; assumeFilesRegenerating?: boolean } = {}
  ) => {
    const data = (listing as any)?.data || listing || {};
    if (data.status) setStatus(data.status);
    setDeclineReason(data.decline_reason || "");
    setFilesGenerating(Boolean(data.files_generating ?? options.assumeFilesGenerating));
    setFilesRegenerating(Boolean(data.files_regenerating ?? options.assumeFilesRegenerating));

    const nextPreviewData = data.preview_data || {
      contract_no: data.contract_no,
      sales_date: data.sales_date,
      location: data.location,
      currency: data.currency,
      total_value: data.total_value,
      lots: data.lots || [],
    };
    if (nextPreviewData) {
      setPreviewData(applyDamageAnalysisLotPolicy({
        ...normalizePreviewLocationData(nextPreviewData),
        include_damage_analysis:
          nextPreviewData.include_damage_analysis ?? (data.include_damage_analysis !== false),
        valuation_methods:
          nextPreviewData.valuation_methods ||
          data.valuation_methods ||
          ["FML"],
      }));
    }

    const nextPreviewFiles = data.preview_files || data.files;
    if (nextPreviewFiles) setPreviewFiles(nextPreviewFiles);
    if (Array.isArray(data.imageUrls)) setImageUrls(data.imageUrls);
  };

  const loadPreviewData = async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    try {
      setLoading(true);
      const [response, categorySpecResponse] = await Promise.all([
        loadLotListingPreview(reportId),
        getAssetCategorySpecs().catch(() => ({ categories: [], specs: [] })),
      ]);
      if (loadRequestRef.current !== requestId) return;
      setCategorySpecs(categorySpecResponse.specs || []);
      applyLotListingState(response);
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

    if (locationBusy) {
      toast.info("Wait for the inspection location to finish resolving.");
      return;
    }

    if (!isLocationReady) {
      toast.error(
        "Enter or resolve a readable inspection location before submitting."
      );
      return;
    }

    if (filesGenerating || filesRegenerating) {
      toast.info("This lot listing is already generating files.");
      return;
    }

    const mutation = beginMutation("submit");
    if (!mutation) return;
    const mutationContext = previewContextRef.current;

    try {
      setSubmitting(true);
      let submittedReport: LotListing | undefined;
      const previewForRequest = applyDamageAnalysisLotPolicy(previewData);
      setPreviewData(previewForRequest);

      if (draftPreviewId) {
        const promoted = await ReportDraftService.promotePreview(draftPreviewId, {
          preview_data: previewForRequest,
          submit: true,
        });
        if (previewContextRef.current !== mutationContext) return;
        setFilesGenerating(true);
        submittedReport = {
          ...promoted,
          _id: promoted.reportId,
        } as unknown as LotListing;
        if (!hasEditsSince(mutation)) setHasChanges(false);
        applyLotListingState(promoted, {
          assumeFilesGenerating: true,
          assumeFilesRegenerating: false,
        });
        toast.success(
          "Draft moved to reports. Files are being generated from your saved preview."
        );
      } else if (effectiveResubmitMode) {
        const updated = resubmitReportOverride
          ? await resubmitReportOverride(reportId, previewForRequest)
          : await resubmitLotListing(reportId, { preview_data: previewForRequest });
        if (previewContextRef.current !== mutationContext) return;
        submittedReport = updated;
        if (!hasEditsSince(mutation)) setHasChanges(false);
        applyLotListingState(updated, {
          assumeFilesGenerating: true,
          assumeFilesRegenerating: true,
        });
        toast.success(
          "Lot listing files will be approved and released automatically after generation succeeds."
        );
      } else {
        // Submit the edited snapshot once. Saving first and then submitting the
        // previous React state allowed the second request to restore stale text.
        const submitted = await submitLotListingForApproval(reportId, { preview_data: previewForRequest });
        if (previewContextRef.current !== mutationContext) return;
        submittedReport = submitted;
        if (!hasEditsSince(mutation)) setHasChanges(false);
        applyLotListingState(submitted, {
          assumeFilesGenerating: true,
          assumeFilesRegenerating: false,
        });
        toast.success("Lot listing files are being generated and will be released automatically.");
      }

      if (onSuccess) onSuccess(submittedReport);
      onClose();
    } catch (error: any) {
      if (previewContextRef.current === mutationContext) {
        toast.error(error.response?.data?.message || "Failed to submit lot listing");
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
      return {
        ...prev,
        lots: newLots,
        total_value:
          field === "estimated_value"
            ? calculateTotalValue(newLots)
            : prev.total_value,
      };
    });
    setHasChanges(true);
  };

  const changeLotSpec = (index: number, fieldName: string, value: string, options: { deleted?: boolean; added?: boolean } = {}) => {
    setPreviewData((prev: any) => {
      const newLots = [...(prev?.lots || [])];
      const lot = newLots[index] || {};
      const categoryFields = categorySpecs.find(spec => normalizeSpecKey(spec.childCategory) === normalizeSpecKey(lot.categories))?.fields || [];
      newLots[index] = applyPreviewSpecEdit(lot, fieldName, value, categoryFields, options);
      return { ...prev, lots: newLots, ...(options.added ? { total_value: calculateTotalValue(newLots) } : {}) };
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
      const next = removeLotPhotoReference(prev, lotIndex, entry) as any;
      return {
        ...next,
        total_value: calculateTotalValue(next?.lots || []),
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
      const previewForRequest = applyDamageAnalysisLotPolicy(previewData);
      setPreviewData(previewForRequest);
      const response = uploadPreviewLotImagesOverride
        ? await uploadPreviewLotImagesOverride(
            reportId,
            lotKey,
            files,
            previewForRequest
          )
        : await uploadLotListingPreviewLotImages(
            reportId,
            lotKey,
            files,
            previewForRequest
          );
      if (previewContextRef.current !== mutationContext) return;
      if (response.data?.preview_data) {
        const nextPreview = hasEditsSince(mutation)
          ? mergeSubmittedPreviewData(
              response.data.preview_data,
              previewDataRef.current || previewForRequest
            )
          : response.data.preview_data;
        setPreviewData(applyDamageAnalysisLotPolicy(nextPreview));
      }
      if (Array.isArray(response.data?.imageUrls)) {
        setImageUrls(response.data.imageUrls);
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

  const deleteLot = (index: number) => {
    setPreviewData((prev: any) => {
      const lots = Array.isArray(prev?.lots) ? [...prev.lots] : [];
      lots.splice(index, 1);
      return { ...prev, lots, total_value: calculateTotalValue(lots) };
    });
    setHasChanges(true);
  };

  const lotsArray: LotListingLot[] = Array.isArray(previewData?.lots) ? previewData.lots : [];
  const displayedTotalValue = calculateTotalValue(lotsArray);
  const includeDamageAnalysis = previewData?.include_damage_analysis !== false;
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
      anchor.download = filename || `lot-listing-cr-${reportId}.pdf`;
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
      anchor.download = filename || `lot-listing-cr-${reportId}.docx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
      toast.success(`Download started: ${anchor.download}`);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || "Unable to download CR DOCX.");
    }
  };

  const mutationMessage =
    activeMutation === "upload"
      ? "Uploading images and updating this preview…"
      : activeMutation === "submit"
          ? effectiveResubmitMode
            ? "Saving changes and queuing regenerated listing files…"
            : "Saving changes and queuing listing files…"
          : "";
  const lockMessage = activeMutation
    ? `${mutationMessage} Keep this page open until it finishes.`
    : "";

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
      title="Lot Listing Preview"
      description="Review your edits, then Save: your edited details are used to rebuild all listing files without re-reading photos. Files release automatically after generation succeeds."
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
            <p className="font-semibold text-[var(--app-text-strong)]">Lot Listing Declined</p>
            <p className="mt-1 text-sm text-[var(--app-danger)]">{declineReason}</p>
          </div>
        </div>
      )}

      {status === "error" && (
        <div role="alert" className="app-alert app-alert--error mb-4">
          Generation failed, but your saved preview is available. Review every lot and photo before saving and resubmitting. Missing analysis must be completed before submission.
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
          <div className="animate-spin h-8 w-8 border-4 border-purple-600 border-t-transparent rounded-full"></div>
        </div>
      ) : (
        <>
          <datalist id="lot-listing-auctioneer-categories">
            {categorySpecs.map((spec) => (
              <option key={spec.childCategory} value={spec.childCategory} />
            ))}
          </datalist>
          {/* Listing Details */}
          <div className="mx-auto max-w-5xl space-y-4 pb-24">
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
              <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                <span className="text-purple-600">📋</span>
                Listing Details
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Contract Number *
                  </label>
                  <input
                    type="text"
                    value={previewData?.contract_no || ""}
                    onChange={(e) => updateField("contract_no", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                    placeholder="e.g., CTR-2024-001"
                  />
                </div>
                <div className="sm:col-span-2 lg:col-span-3">
                  <label
                    htmlFor="lot-listing-preview-inspection-location"
                    className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5"
                  >
                    Inspection Location *
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      id="lot-listing-preview-inspection-location"
                      type="text"
                      value={previewData?.location || ""}
                      onChange={(event) => updateLocation(event.target.value)}
                      aria-describedby="lot-listing-preview-location-status"
                      aria-invalid={!isLocationReady}
                      className="min-w-0 flex-1 px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
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
                    id="lot-listing-preview-location-status"
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
                    Currency
                  </label>
                  <select
                    value={previewData?.currency || "CAD"}
                    onChange={(e) => updateField("currency", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                  >
                    <option value="CAD">CAD - Canadian Dollar</option>
                    <option value="USD">USD - US Dollar</option>
                    <option value="EUR">EUR - Euro</option>
                    <option value="GBP">GBP - British Pound</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4 shadow-sm sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h4 className="text-sm font-bold text-[var(--app-text)]">Damages</h4>
                  <p className="mt-1 text-sm text-[var(--app-text-muted)]">
                    Applies to lot numbers up to and including 1000. Lot numbers above 1000 never require Damage Analysis.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    updateField("include_damage_analysis", !includeDamageAnalysis)
                  }
                  className={`app-button ${
                    includeDamageAnalysis
                      ? "app-button--primary"
                      : "app-button--secondary"
                  }`}
                >
                  {includeDamageAnalysis ? "Included" : "Excluded"}
                </button>
              </div>
            </div>

            {/* Quick Stats */}
            <div className="bg-[var(--app-panel)] from-purple-50 to-indigo-50 border border-purple-200 rounded-xl p-4">
              <h4 className="text-sm font-bold text-[var(--app-text)] mb-3">📊 Listing Statistics</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="text-center">
                  <div className="text-2xl font-bold text-purple-600">{lotsArray.length}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Total Lots</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-600">{previewData?.currency || "CAD"}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Currency</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-600">{imageUrls.length}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Images</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-[var(--app-warning)]">
                    {displayedTotalValue
                      ? `${previewData.currency || "CAD"} ${displayedTotalValue.toLocaleString()}`
                      : "-"}
                  </div>
                  <div className="text-xs text-[var(--app-text-muted)]">Total Value</div>
                </div>
              </div>
            </div>

          </div>

          {/* Lot photo viewer: a floating window that can be moved, resized,
              minimized and maximized; Left/Right arrows step through photos. */}
          {galleryLotImages !== null && (
            <FloatingPhotoViewer
              title={(() => {
                const lotIndex = galleryLotImages.entries[0]?.lotIndex ?? 0;
                return `Lot #${getLotDisplayNumber(lotsArray[lotIndex], lotIndex)}`;
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

          {/* Lots Section */}
          <div className="mt-6 space-y-4 max-w-5xl mx-auto">
            <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)]">Lots ({lotsArray.length})</h3>
            <p className="text-sm text-[var(--app-text-muted)]">The Title is used as the Description in generated Excel and condition report files.</p>
            {lotsArray.length > 0 ? (
              <div className="space-y-4">
                {lotsArray.map((lot, idx) => {
                  const lotImages = getLotPhotoEntries(lot);
                  const lotUploadKey = getLotUploadKey(lot, idx);
                  const uploadInputId = `lot-listing-preview-upload-${idx}`;
                  const openLotGallery = (startIdx: number) => {
                    setGalleryLotImages({
                      entries: lotImages.map((entry) => ({ ...entry, lotIndex: idx })),
                      currentIdx: startIdx,
                    });
                  };

                  return (
                    <div key={idx} className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] shadow-sm ">
                      <div className="mb-3 flex items-center justify-between border-t-4 border-purple-500 bg-[var(--app-panel)] px-4 py-4 shadow-sm">
                        <div className="text-sm font-semibold text-[var(--app-text)]">
                          Lot #{getLotDisplayNumber(lot, idx)}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => deleteLot(idx)}
                            className="app-button app-button--danger !min-h-7 !rounded-md !px-2 !py-1 !text-xs"
                          >
                            Delete
                          </button>
                        </div>
                      </div>

                      {/* Lot Images */}
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
                            disabled={
                              activeMutation !== null ||
                              filesGenerating ||
                              filesRegenerating
                            }
                            className="hidden"
                            onChange={(event) => {
                              handleUploadLotImages(lot, idx, event.target.files);
                              event.currentTarget.value = "";
                            }}
                          />
                          <button
                            type="button"
                            disabled={
                              activeMutation !== null ||
                              filesGenerating ||
                              filesRegenerating
                            }
                            onClick={() => document.getElementById(uploadInputId)?.click()}
                            className="app-button app-button--secondary !min-h-7 !rounded-md !px-2.5 !py-1 !text-[11px]"
                          >
                            <Upload className="h-3 w-3" />
                            {uploadingLotKey === lotUploadKey ? "Uploading" : "Upload images"}
                          </button>
                        </div>
                        {lotImages.length > 0 && (
                          <div className="flex gap-2 overflow-x-auto pb-2">
                            {lotImages.slice(0, 10).map(({ url, globalIndex }, imgIdx) => (
                              <div
                                key={imgIdx}
                                className="relative flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border border-[var(--app-border)] cursor-pointer hover:border-purple-500 transition-all"
                                onClick={() => openLotGallery(imgIdx)}
                              >
                                { }
                                <img src={url} alt={`Photo ${imgIdx + 1}`} className="w-full h-full object-cover" />
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    deleteLotImage(idx, { globalIndex, url });
                                  }}
                                  className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-red-600 text-[10px] font-black text-white shadow"
                                  aria-label={`Remove photo ${imgIdx + 1}`}
                                >
                                  x
                                </button>
                              </div>
                            ))}
                            {lotImages.length > 10 && (
                              <button
                                type="button"
                                className="flex h-16 w-16 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] transition-colors hover:border-[var(--app-accent)] hover:bg-[var(--app-accent-soft)] hover:text-[var(--app-accent)]"
                                onClick={() => openLotGallery(10)}
                                aria-label={`Open ${lotImages.length - 10} more photos`}
                              >
                                <span className="text-xs font-semibold text-[var(--app-text-muted)]">+{lotImages.length - 10}</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Lot Fields */}
                      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
                        <div>
                          <label className="block text-xs text-[var(--app-text-muted)] mb-1">Lot #</label>
                          <input
                            type="text"
                            value={String(lot.lot_number ?? getLotDisplayNumber(lot, idx))}
                            onChange={(e) => updateLot(idx, "lot_number", e.target.value)}
                            className="w-full px-3 py-2 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                            placeholder={String(idx + 1)}
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-[var(--app-text-muted)] mb-1">Title</label>
                          <input
                            type="text"
                            value={lot.title || ""}
                            onChange={(e) => updateLot(idx, "title", e.target.value)}
                            className="w-full px-3 py-2 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                            placeholder="Lot title"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-[var(--app-text-muted)] mb-1">Est. Value</label>
                          <input
                            type="text"
                            value={lot.estimated_value || ""}
                            onChange={(e) => updateLot(idx, "estimated_value", e.target.value)}
                            className="w-full px-3 py-2 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                            placeholder="0.00"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-[var(--app-text-muted)] mb-1">Category</label>
                          <input
                            type="text"
                            list="lot-listing-auctioneer-categories"
                            value={lot.categories || ""}
                            onChange={(e) => updateLot(idx, "categories", e.target.value)}
                            className="w-full px-3 py-2 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                            placeholder="Category"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-[var(--app-text-muted)] mb-1">Item Condition</label>
                          <input
                            type="text"
                            value={lot.item_condition || ""}
                            onChange={(e) => updateLot(idx, "item_condition", e.target.value)}
                            className="w-full px-3 py-2 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                            placeholder="Excel item condition"
                          />
                        </div>
                        <div className="sm:col-span-2">
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
                            accent="purple"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-[var(--app-text-muted)] mb-1">Serial Number</label>
                          <input
                            type="text"
                            value={lot.serial_number || ""}
                            onChange={(e) => updateLot(idx, "serial_number", e.target.value)}
                            className="w-full px-3 py-2 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                            placeholder="Serial/VIN"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-[var(--app-text-muted)] mb-1">Quantity</label>
                          <input
                            type="number"
                            value={lot.quantity || 1}
                            onChange={(e) => updateLot(idx, "quantity", parseInt(e.target.value) || 1)}
                            className="w-full px-3 py-2 border border-[var(--app-border)] rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                            min={1}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-[var(--app-text-muted)]">
                No lots in this listing yet.
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="sticky bottom-0 z-10 mx-auto mt-4 flex max-w-5xl flex-wrap items-center justify-between gap-2.5 border-t border-[var(--app-border)] bg-[var(--app-panel)] pt-3 pb-1">
            <div className="flex items-center gap-2">
              {hasChanges && (
                <span className="text-xs font-medium text-[var(--app-warning)]">Unsaved changes</span>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <button
                type="button"
                onClick={handleSubmitForApproval}
                disabled={
                  editorLocked ||
                  loading ||
                  locationBusy ||
                  filesGenerating ||
                  filesRegenerating
                }
                className="app-button app-button--primary"
                aria-label="Save preview"
                title={SAVE_PREVIEW_TITLE}
              >
                {submitting ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {submitting
                  ? "Saving..."
                  : filesGenerating || filesRegenerating
                    ? "Generating files..."
                    : "Save"}
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
