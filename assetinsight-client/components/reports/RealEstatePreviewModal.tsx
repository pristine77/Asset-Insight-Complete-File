"use client";

import React, { useState, useEffect, useRef } from "react";
import { Save, Send, AlertCircle, Building2, Image } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { RealEstateService } from "@/services/realEstate";
import BottomDrawer from "@/components/BottomDrawer";
import FloatingPhotoViewer from "@/components/reports/FloatingPhotoViewer";

interface RealEstatePreviewModalProps {
  reportId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  isResubmitMode?: boolean;
  loadPreviewDataOverride?: (reportId: string) => Promise<any>;
  updatePreviewDataOverride?: (
    reportId: string,
    previewData: any
  ) => Promise<{ message: string; data: any; files_regeneration_queued?: boolean }>;
  resubmitReportOverride?: (
    reportId: string,
    previewData?: any
  ) => Promise<{ message: string; data: any }>;
  isAssignedApprovalMode?: boolean;
}

export default function RealEstatePreviewModal({
  reportId,
  isOpen,
  onClose,
  onSuccess,
  isResubmitMode = false,
  loadPreviewDataOverride,
  updatePreviewDataOverride,
  resubmitReportOverride,
  isAssignedApprovalMode = false,
}: RealEstatePreviewModalProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [declineReason, setDeclineReason] = useState<string>("");
  const [previewData, setPreviewData] = useState<any>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [propertyType, setPropertyType] = useState<string>("");
  const [language, setLanguage] = useState<string>("en");
  const [imageCount, setImageCount] = useState<number>(0);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);
  const [filesGenerating, setFilesGenerating] = useState(false);
  const [filesRegenerating, setFilesRegenerating] = useState(false);
  const [mainImageCount, setMainImageCount] = useState(0);
  const requestVersion = useRef(0);
  const mutationInFlight = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busy = saving || submitting;
  const resubmitting = status ? ["pending_approval", "approved"].includes(status) : isResubmitMode;
  const farmlandValuation = previewData?.farmland_valuation;
  const farmlandApproaches = farmlandValuation?.approaches_used;

  useEffect(() => {
    const version = ++requestVersion.current;
    mutationInFlight.current = false;
    setHasChanges(false);
    setSaving(false);
    setSubmitting(false);
    setSelectedImageIndex(null);
    if (isOpen && reportId) {
      void loadPreviewData(version);
    }
    return () => { requestVersion.current += 1; };
  }, [isOpen, reportId, loadPreviewDataOverride]);

  const loadPreviewData = async (version: number) => {
    try {
      setLoading(true);
      const response = loadPreviewDataOverride
        ? await loadPreviewDataOverride(reportId)
        : await RealEstateService.getPreviewData(reportId);
      if (version !== requestVersion.current) return;
      setStatus(response.data.status);
      setDeclineReason(response.data.decline_reason || "");
      setFilesGenerating(Boolean(response.data.files_generating));
      setFilesRegenerating(Boolean(response.data.files_regenerating));
      setPreviewData(response.data.preview_data || {});
      setPropertyType(response.data.property_type || response.data.preview_data?.property_type || "residential");
      setLanguage(response.data.language || "en");
      const mainPhotos: string[] = response.data.imageUrls || [];
      const reportOnlyPhotos: string[] = response.data.extraImageUrls || [];
      setMainImageCount(mainPhotos.length);
      setImageCount(mainPhotos.length + reportOnlyPhotos.length);
      setImageUrls([...mainPhotos, ...reportOnlyPhotos]);
    } catch (error: any) {
      if (version !== requestVersion.current) return;
      toast.error(error.response?.data?.message || "Failed to load preview data");
      onCloseRef.current();
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  };

  const handleSaveChanges = async () => {
    if (mutationInFlight.current || loading || filesGenerating || filesRegenerating || !hasChanges) return;
    mutationInFlight.current = true;
    const version = requestVersion.current;
    try {
      setSaving(true);
      const savePreview = updatePreviewDataOverride || RealEstateService.updatePreviewData;
      await savePreview(reportId, previewData);
      if (version !== requestVersion.current) return;
      setHasChanges(false);
      toast.success(
        isAssignedApprovalMode
          ? "Changes saved. Submit to regenerate and approve the report."
          : "Changes saved successfully!"
      );
    } catch (error: any) {
      if (version !== requestVersion.current) return;
      toast.error(error.response?.data?.message || "Failed to save changes");
    } finally {
      if (version === requestVersion.current) {
        mutationInFlight.current = false;
        setSaving(false);
      }
    }
  };

  const handleSubmitForApproval = async () => {
    if (mutationInFlight.current || loading) return;
    if (!previewData) {
      toast.error("No preview data available");
      return;
    }

    if (filesGenerating || filesRegenerating) {
      toast.info("This report is already generating files.");
      return;
    }

    if (hasChanges && !isAssignedApprovalMode) {
      toast.warning("Please save your changes before submitting");
      return;
    }

    mutationInFlight.current = true;
    const version = requestVersion.current;
    try {
      setSubmitting(true);
      if (resubmitting || resubmitReportOverride) {
        const submitUpdatedReport = resubmitReportOverride || RealEstateService.resubmitReport;
        await submitUpdatedReport(reportId, hasChanges || isAssignedApprovalMode ? previewData : undefined);
        if (version !== requestVersion.current) return;
        toast.success(
          isAssignedApprovalMode
            ? "Files are regenerating. The report will approve after generation succeeds."
            : "Report resubmitted successfully! Files are being regenerated."
        );
      } else {
        await RealEstateService.submitForApproval(reportId);
        if (version !== requestVersion.current) return;
        toast.success("Report submitted for approval successfully!");
      }
      if (onSuccess) onSuccess();
      onClose();
    } catch (error: any) {
      if (version !== requestVersion.current) return;
      toast.error(error.response?.data?.message || "Failed to submit for approval");
    } finally {
      if (version === requestVersion.current) {
        mutationInFlight.current = false;
        setSubmitting(false);
      }
    }
  };

  const updateField = (path: string, value: any) => {
    if (mutationInFlight.current || filesGenerating || filesRegenerating) return;
    setPreviewData((prev: any) => {
      const parts = path.split(".");
      const newData = { ...prev };
      let current: any = newData;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]]) current[parts[i]] = {};
        current[parts[i]] = { ...current[parts[i]] };
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = value;
      return newData;
    });
    setHasChanges(true);
  };

  const getValue = (path: string) => {
    const parts = path.split(".");
    let current: any = previewData;
    for (const part of parts) {
      if (!current) return "";
      current = current[part];
    }
    return current ?? "";
  };

  return (
    <BottomDrawer open={isOpen} onClose={() => { if (!mutationInFlight.current) onClose(); }} closeDisabled={busy} title="Real Estate Report Preview">
      <div className="preview-editor">
      {!loading && previewData?.valuation_warning && (
        <div role="alert" className="app-alert app-alert--warning mb-3">
          {previewData.valuation_warning}
        </div>
      )}
      {status === "declined" && declineReason && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-red-900">Report Declined</p>
            <p className="text-sm text-red-700 mt-1">{declineReason}</p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin h-8 w-8 border-4 border-emerald-600 border-t-transparent rounded-full"></div>
        </div>
      ) : (
        <>
          <fieldset disabled={busy || filesGenerating || filesRegenerating} className="mx-auto min-w-0 max-w-5xl space-y-4 border-0 p-0 pb-6">
            {/* Report Type Badge */}
            <div className="flex items-center gap-3 p-3 bg-[var(--app-panel)] border border-[var(--app-border)] rounded-xl">
              <Building2 className="h-6 w-6 text-emerald-600" />
              <div>
                <p className="font-semibold text-[var(--app-text)] capitalize">{propertyType} Property</p>
                <p className="text-sm text-[var(--app-text-muted)]">Language: {language.toUpperCase()} | {mainImageCount} main photos | {imageCount - mainImageCount} report-only photos</p>
              </div>
            </div>

            {/* Property Details Section */}
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
              <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                <span className="text-emerald-600">🏠</span>
                Property Details
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="sm:col-span-2 lg:col-span-3">
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Address *
                  </label>
                  <input
                    type="text"
                    value={getValue("property_details.address")}
                    onChange={(e) => updateField("property_details.address", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="Property address"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Owner Name
                  </label>
                  <input
                    type="text"
                    value={getValue("property_details.owner_name")}
                    onChange={(e) => updateField("property_details.owner_name", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="Owner name"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Municipality
                  </label>
                  <input
                    type="text"
                    value={getValue("property_details.municipality")}
                    onChange={(e) => updateField("property_details.municipality", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="Municipality"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Title Number
                  </label>
                  <input
                    type="text"
                    value={getValue("property_details.title_number")}
                    onChange={(e) => updateField("property_details.title_number", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="Title number"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Land Area (Acres)
                  </label>
                  <input
                    type="text"
                    value={getValue("property_details.land_area_acres")}
                    onChange={(e) => updateField("property_details.land_area_acres", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="e.g., 160"
                  />
                </div>
              </div>
            </div>

            {/* Report Dates Section */}
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
              <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                <span className="text-blue-600">📅</span>
                Report Dates
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Report Date
                  </label>
                  <input
                    type="date"
                    value={getValue("report_dates.report_date")?.split("T")[0] || ""}
                    onChange={(e) => updateField("report_dates.report_date", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Effective Date
                  </label>
                  <input
                    type="date"
                    value={getValue("report_dates.effective_date")?.split("T")[0] || ""}
                    onChange={(e) => updateField("report_dates.effective_date", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Inspection Date
                  </label>
                  <input
                    type="date"
                    value={getValue("report_dates.inspection_date")?.split("T")[0] || ""}
                    onChange={(e) => updateField("report_dates.inspection_date", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                  />
                </div>
              </div>
            </div>

            {/* House Details Section */}
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
              <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                <span className="text-purple-600">🏢</span>
                Building Details
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Year Built
                  </label>
                  <input
                    type="text"
                    value={getValue("house_details.year_built")}
                    onChange={(e) => updateField("house_details.year_built", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="e.g., 2010"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Square Footage
                  </label>
                  <input
                    type="text"
                    value={getValue("house_details.square_footage")}
                    onChange={(e) => updateField("house_details.square_footage", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="e.g., 2500"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Lot Size (sqft)
                  </label>
                  <input
                    type="text"
                    value={getValue("house_details.lot_size_sqft")}
                    onChange={(e) => updateField("house_details.lot_size_sqft", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="e.g., 5000"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Rooms
                  </label>
                  <input
                    type="text"
                    value={getValue("house_details.number_of_rooms")}
                    onChange={(e) => updateField("house_details.number_of_rooms", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="e.g., 4"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Full Bathrooms
                  </label>
                  <input
                    type="text"
                    value={getValue("house_details.number_of_full_bathrooms")}
                    onChange={(e) => updateField("house_details.number_of_full_bathrooms", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="e.g., 2"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Half Bathrooms
                  </label>
                  <input
                    type="text"
                    value={getValue("house_details.number_of_half_bathrooms")}
                    onChange={(e) => updateField("house_details.number_of_half_bathrooms", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="e.g., 1"
                  />
                </div>
              </div>
            </div>

            {/* Valuation Section */}
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
              <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                <span className="text-green-600">💰</span>
                Valuation
              </h3>
              {farmlandValuation && (
                <div className="mb-4 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3" aria-label="Calculated farmland valuation">
                  <p className="text-xs text-[var(--app-text-muted)]">Calculated farmland value</p>
                  <p className="mt-1 text-lg font-semibold text-[var(--app-text)]">{farmlandValuation.fair_market_value_formatted ?? previewData.fair_market_value ?? farmlandValuation.fair_market_value ?? "Not available"}</p>
                  {farmlandApproaches && (
                    <p className="mt-1 text-sm text-[var(--app-text)]">{[
                      farmlandApproaches.direct_comparable && "Direct Comparable",
                      farmlandApproaches.income_capitalization && "Income Capitalization",
                      farmlandApproaches.cost_approach && "Cost Approach",
                    ].filter(Boolean).join(" · ")}</p>
                  )}
                  <p className="mt-2 text-xs text-[var(--app-text-muted)]">Saved calculation. Editing preview fields does not rerun the valuation. Review the estimate before submitting.</p>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Fair Market Value
                  </label>
                  <input
                    type="text"
                    value={getValue("valuation.fair_market_value")}
                    onChange={(e) => updateField("valuation.fair_market_value", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="e.g., $500,000 CAD"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Value Source
                  </label>
                  <input
                    type="text"
                    value={getValue("valuation.value_source")}
                    onChange={(e) => updateField("valuation.value_source", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="e.g., Direct Comparison Approach"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Valuation Summary
                  </label>
                  <textarea
                    value={getValue("valuation.final_estimate_summary")}
                    onChange={(e) => updateField("valuation.final_estimate_summary", e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="Summary of valuation methodology..."
                  />
                </div>
              </div>
            </div>

            {/* Inspector Info Section */}
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
              <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                <span className="text-amber-600">👤</span>
                Inspector Info
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Inspector Name
                  </label>
                  <input
                    type="text"
                    value={getValue("inspector_info.inspector_name")}
                    onChange={(e) => updateField("inspector_info.inspector_name", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="Inspector name"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Company Name
                  </label>
                  <input
                    type="text"
                    value={getValue("inspector_info.company_name")}
                    onChange={(e) => updateField("inspector_info.company_name", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="Company name"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Contact Email
                  </label>
                  <input
                    type="email"
                    value={getValue("inspector_info.contact_email")}
                    onChange={(e) => updateField("inspector_info.contact_email", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="email@example.com"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                    Credentials
                  </label>
                  <input
                    type="text"
                    value={getValue("inspector_info.credentials")}
                    onChange={(e) => updateField("inspector_info.credentials", e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    placeholder="e.g., CRA, AACI"
                  />
                </div>
              </div>
            </div>

            {/* Farmland Details Section (if farmland) */}
            {(propertyType === 'agricultural' || propertyType === 'farmland') && (
              <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
                <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                  <span className="text-green-600">🌾</span>
                  Farmland Details
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                      Total Title Acres
                    </label>
                    <input
                      type="number"
                      value={getValue("farmland_details.total_title_acres")}
                      onChange={(e) => updateField("farmland_details.total_title_acres", parseFloat(e.target.value) || 0)}
                      className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                      placeholder="160"
                    />
                  </div>
                  <div>
                    <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                      Cultivated Acres
                    </label>
                    <input
                      type="number"
                      value={getValue("farmland_details.cultivated_acres")}
                      onChange={(e) => updateField("farmland_details.cultivated_acres", parseFloat(e.target.value) || 0)}
                      className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                      placeholder="150"
                    />
                  </div>
                  <div>
                    <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                      RM Area
                    </label>
                    <input
                      type="text"
                      value={getValue("farmland_details.rm_area")}
                      onChange={(e) => updateField("farmland_details.rm_area", e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                      placeholder="RM of Corman Park"
                    />
                  </div>
                  <div>
                    <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                      Soil Class
                    </label>
                    <input
                      type="text"
                      value={getValue("farmland_details.soil_class")}
                      onChange={(e) => updateField("farmland_details.soil_class", e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                      placeholder="Class 2"
                    />
                  </div>
                  <div>
                    <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                      Crop Type
                    </label>
                    <input
                      type="text"
                      value={getValue("farmland_details.crop_type")}
                      onChange={(e) => updateField("farmland_details.crop_type", e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                      placeholder="Wheat, Canola"
                    />
                  </div>
                  <div>
                    <label className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
                      Rent/Acre (if rented)
                    </label>
                    <input
                      type="number"
                      value={getValue("farmland_details.annual_rent_per_acre")}
                      onChange={(e) => updateField("farmland_details.annual_rent_per_acre", parseFloat(e.target.value) || 0)}
                      className="w-full px-3 py-2 text-sm border border-[var(--app-border)] rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                      placeholder="50"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Quick Stats */}
            <div className="bg-[var(--app-panel)] from-emerald-50 to-teal-50 border border-emerald-200 rounded-xl p-4">
              <h4 className="text-sm font-bold text-[var(--app-text)] mb-3">📊 Report Statistics</h4>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="text-center">
                  <div className="text-2xl font-bold text-emerald-600 capitalize">{propertyType}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Property Type</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-600">{language.toUpperCase()}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Language</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-purple-600">{imageCount}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">Images</div>
                </div>
              </div>
            </div>

            {/* Photo Preview Section */}
            {imageUrls.length > 0 && (
              <div className="mt-6 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-4 shadow-sm  sm:p-6">
                <h3 className="text-base sm:text-lg font-bold text-[var(--app-text)] mb-4 flex items-center gap-2">
                  <Image className="h-5 w-5 text-emerald-600" />
                  Report Photos ({imageUrls.length})
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {imageUrls.map((url, idx) => (
                    <button
                      type="button"
                      key={idx}
                      aria-label={`View ${idx < mainImageCount ? "main" : "report-only"} photo ${idx < mainImageCount ? idx + 1 : idx - mainImageCount + 1}`}
                      className="relative group cursor-pointer aspect-square rounded-lg overflow-hidden border border-[var(--app-border)] hover:border-emerald-400 transition-all shadow-sm hover:shadow-md"
                      onClick={() => setSelectedImageIndex(idx)}
                    >
                      { }
                      <img
                        loading="lazy"
                        src={url}
                        alt={`Property Photo ${idx + 1}`}
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center">
                        <span className="opacity-0 group-hover:opacity-100 text-white text-xs font-medium bg-black/50 px-2 py-1 rounded">
                          View
                        </span>
                      </div>
                      <div className="absolute bottom-1 right-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">
                        {idx + 1}
                      </div>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-[var(--app-text-muted)] mt-3">Click any photo to view larger. Photos will appear in the final report.</p>
              </div>
            )}
          </fieldset>

          {/* Property photo viewer: a floating window that can be moved,
              resized, minimized and maximized; Left/Right arrows step through photos. */}
          {selectedImageIndex !== null && (
            <FloatingPhotoViewer
              title="Property"
              entries={imageUrls.map((url, index) => ({ url, key: `${index}-${url}` }))}
              index={selectedImageIndex}
              onIndexChange={setSelectedImageIndex}
              onClose={() => setSelectedImageIndex(null)}
            />
          )}

          {/* Action Buttons */}
          <div className="sticky bottom-0 z-10 mt-4 flex flex-col items-center justify-end gap-2.5 border-t border-[var(--app-border)] bg-[var(--app-panel)] pt-3 pb-1 sm:flex-row">
            <button
              onClick={handleSaveChanges}
              disabled={busy || !hasChanges || filesGenerating || filesRegenerating}
              className="app-button app-button--secondary w-full sm:w-auto"
            >
              <Save className="h-5 w-5" />
              {saving ? "Saving..." : "Save Changes"}
            </button>
            <button
              onClick={handleSubmitForApproval}
              disabled={busy || filesGenerating || filesRegenerating || (!isAssignedApprovalMode && hasChanges)}
              className="app-button app-button--primary w-full sm:w-auto"
            >
              <Send className="h-5 w-5" />
              {submitting
                ? "Submitting..."
                : filesRegenerating
                  ? "Regenerating Files..."
                  : isAssignedApprovalMode
                    ? "Submit & Approve"
                    : resubmitting ? "Resubmit for Approval" : "Submit for Approval"}
            </button>
          </div>
        </>
      )}
      </div>
    </BottomDrawer>
  );
}
