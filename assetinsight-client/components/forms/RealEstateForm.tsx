"use client";

import { useEffect, useRef, useState } from "react";
import { useAuthContext } from "@/context/AuthContext";
import {
  RealEstateService,
  type RealEstateDetails,
} from "@/services/realEstate";
import { Check, Save } from "lucide-react";
import {
  SavedInputService,
  type SavedInput,
  type RealEstateFormData,
} from "@/services/savedInputs";
import { AIService, type RealEstateDetailsPatch } from "@/services/ai";
import { toast } from "@/components/ui/toast";

// Section Components
import {
  RealEstateSection,
  PropertyDetailsSection,
  BuildingDetailsSection,
  FarmlandDetailsSection,
  MapUploadSection,
  AIAssistSection,
  type RealEstateProperty,
} from "./real-estate";

type Props = {
  onSuccess?: (message?: string) => void;
  onCancel?: () => void;
  onSubmittingChange?: (submitting: boolean) => void;
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export type RealEstateFormHandle = {
  loadSavedInput: (savedInput: SavedInput) => void;
};

export default function RealEstateForm({ onSuccess, onCancel, onSubmittingChange }: Props) {
  const { user } = useAuthContext();
  const [details, setDetails] = useState<RealEstateDetails>({
    language: "en",
    property_type: "residential",
    property_details: {
      owner_name: "",
      address: "",
      land_description: "",
      municipality: "",
      title_number: "",
      parcel_number: "",
      land_area_acres: "",
      source_quarter_section: "",
    },
    report_dates: {
      report_date: isoDate(new Date()),
      effective_date: isoDate(new Date()),
      inspection_date: isoDate(new Date()),
    },
    house_details: {
      year_built: "",
      square_footage: "",
      lot_size_sqft: "",
      number_of_rooms: "",
      number_of_full_bathrooms: "",
      number_of_half_bathrooms: "",
      known_issues: [],
    },
    farmland_details: {
      total_title_acres: undefined,
      cultivated_acres: undefined,
      rm_area: "",
      soil_class: "",
      crop_type: "",
      is_rented: false,
      annual_rent_per_acre: undefined,
      irrigation: false,
      access_quality: "good",
      distance_to_city_km: undefined,
      // Direct Comparable Approach fields
      use_direct_comparable: false,
      subject_name: "",
      valuation_date: isoDate(new Date()),
      notes: "",
      // Income Capitalization Approach fields
      use_income_approach: false,
      market_rent_per_acre: undefined,
      vacancy_loss_percent: 2,
      operating_expense_ratio: 20,
      cap_rate: 5,
      // Cost Approach (AI-calculated)
      use_cost_approach: false,
    },
    inspector_info: {
      inspector_name: "",
      company_name: "",
      contact_email: "",
      contact_phone: "",
      credentials: "",
    },
  });

  const [property, setProperty] = useState<RealEstateProperty | null>(null);
  const [mapImage, setMapImage] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const submissionRef = useRef(false);
  const [specFiles, setSpecFiles] = useState<File[]>([]);
  const [notesText, setNotesText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [progressPercent, setProgressPercent] = useState(0);

  useEffect(() => {
    if (!submitting) return;
    const protectUpload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUpload);
    return () => window.removeEventListener("beforeunload", protectUpload);
  }, [submitting]);

  // Sync property type from RealEstateSection to details
  useEffect(() => {
    if (property?.propertyType && property.propertyType !== details.property_type) {
      setDetails((prev) => ({
        ...prev,
        property_type: property.propertyType as "agricultural" | "commercial" | "residential",
        property_details: {
          ...prev.property_details,
          property_type: property.propertyType,
        },
      }));
    }
  }, [property?.propertyType]);

  function handleChange<
    K1 extends keyof RealEstateDetails,
    K2 extends keyof RealEstateDetails[K1] & string
  >(section: K1, field: K2, value: string) {
    setDetails((prev) => ({
      ...prev,
      [section]: {
        ...(prev[section] as any),
        [field]: value,
      } as any,
    }));
  }

  function handleKnownIssuesChange(value: string) {
    const issues = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setDetails((prev) => ({
      ...prev,
      house_details: {
        ...prev.house_details,
        known_issues: issues,
      },
    }));
  }

  function handleFarmlandChange<
    K extends keyof NonNullable<RealEstateDetails["farmland_details"]>
  >(field: K, value: NonNullable<RealEstateDetails["farmland_details"]>[K]) {
    setDetails((prev) => ({
      ...prev,
      farmland_details: {
        ...prev.farmland_details,
        [field]: value,
      },
    }));
  }

  function handlePropertyTypeChange(
    type: "agricultural" | "commercial" | "residential"
  ) {
    setDetails((prev) => ({
      ...prev,
      property_type: type,
      property_details: {
        ...prev.property_details,
        property_type: type,
      },
    }));
  }

  function handleMapImageChange(files: FileList | null) {
    if (!files || files.length === 0) {
      setMapImage(null);
      return;
    }
    setMapImage(files[0]);
  }

  function removeMapImage() {
    setMapImage(null);
  }

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  function mergeNonEmpty<T extends Record<string, any>>(
    prev: T,
    patch?: Partial<T>
  ): T {
    if (!patch) return prev;
    const out: T = { ...prev };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        if (value.length > 0) (out as any)[key] = value;
        continue;
      }
      if (typeof value === "string") {
        if (value.trim() !== "") (out as any)[key] = value;
        continue;
      }
      (out as any)[key] = value;
    }
    return out;
  }

  function applyPatch(patch: RealEstateDetailsPatch) {
    setDetails((prev) => {
      // Normalize known_issues if it accidentally comes as a string
      let housePatch = patch.house_details;
      const ki: any = (housePatch as any)?.known_issues;
      if (typeof ki === "string") {
        const arr = ki
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
        housePatch = { ...housePatch, known_issues: arr } as any;
      }

      const merged: RealEstateDetails = {
        ...prev,
        property_details: mergeNonEmpty(
          prev.property_details,
          patch.property_details
        ),
        report_dates: mergeNonEmpty(prev.report_dates, patch.report_dates),
        house_details: mergeNonEmpty(prev.house_details, housePatch),
        inspector_info: mergeNonEmpty(
          prev.inspector_info,
          patch.inspector_info
        ),
      };

      return merged;
    });
  }

  function handleSpecChange(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }
    // Append new files, limit to 5 total
    setSpecFiles((prev) => {
      const combined = [...prev, ...Array.from(files)];
      return combined.slice(0, 5);
    });
  }

  function removeSpecFile(index: number) {
    setSpecFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function analyzeSpec() {
    if (specFiles.length === 0) return;
    try {
      setAiLoading(true);
      const patch = await AIService.fillFromSpecSheet(specFiles);
      applyPatch(patch);
    } catch (e: any) {
      setError(e?.message || "Failed to analyze spec sheet");
    } finally {
      setAiLoading(false);
    }
  }

  async function fillFromText() {
    const text = notesText.trim();
    if (!text) return;
    try {
      setAiLoading(true);
      const patch = await AIService.fillFromText(text);
      applyPatch(patch);
    } catch (e: any) {
      setError(e?.message || "Failed to process text");
    } finally {
      setAiLoading(false);
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        chunksRef.current = [];
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      setError(null);
      setAudioBlob(null);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
      setIsRecording(true);
    } catch (e: any) {
      setError(e?.message || "Unable to access microphone");
    }
  }

  function stopRecording() {
    const mr = mediaRecorderRef.current;
    if (mr && (mr.state === "recording" || mr.state === "paused")) {
      mr.stop();
    }
    setIsRecording(false);
  }

  function clearRecording() {
    setAudioBlob(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
  }

  async function useRecording() {
    if (!audioBlob) return;
    try {
      setAiLoading(true);
      const file = new File([audioBlob], "audio.webm", { type: "audio/webm" });
      const patch = await AIService.fillFromAudio(file);
      applyPatch(patch);
    } catch (e: any) {
      setError(e?.message || "Failed to process audio");
    } finally {
      setAiLoading(false);
    }
  }

  // Save inputs to database
  async function saveInputs() {
    try {
      const baseName =
        details.property_details?.address?.trim() ||
        details.property_details?.owner_name?.trim() ||
        "Unnamed Property";
      const dateStr = new Date().toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const autoName = `${baseName} - ${dateStr}`;

      const formData: RealEstateFormData = {
        language: details.language,
        property_type: details.property_type,
        property_details: details.property_details,
        report_dates: details.report_dates,
        house_details: details.house_details,
        farmland_details: details.farmland_details,
      };

      await SavedInputService.create({
        name: autoName,
        formType: "realEstate",
        formData,
      });

      toast.success("Draft saved successfully!");
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Failed to save draft");
    }
  }

  // Load saved input from history
  function loadSavedInput(savedInput: SavedInput) {
    try {
      const fd = savedInput.formData as RealEstateFormData;
      if (!fd) return;

      setDetails((prev) => ({
        ...prev,
        language: fd.language || prev.language,
        property_type: fd.property_type || prev.property_type,
        property_details: {
          ...prev.property_details,
          ...fd.property_details,
        },
        report_dates: {
          ...prev.report_dates,
          ...fd.report_dates,
        },
        house_details: {
          ...prev.house_details,
          ...fd.house_details,
        },
        farmland_details: {
          ...prev.farmland_details,
          ...fd.farmland_details,
        },
      }));

      toast.success(`Loaded: ${savedInput.name}`);
    } catch (error) {
      toast.error("Failed to load saved draft");
    }
  }

  // Listen for global event to load saved input (from Navbar)
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const savedInput = e.detail;
      if (savedInput && savedInput.formType === "realEstate") {
        loadSavedInput(savedInput);
      }
    };
    window.addEventListener("load-realestate-input" as any, handler as any);
    return () => {
      window.removeEventListener(
        "load-realestate-input" as any,
        handler as any
      );
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submissionRef.current || accepted) return;
    if (!details.property_details.address) {
      setError("Address is required.");
      toast.error("Address is required.");
      return;
    }

    if (!property || !property.propertyType) {
      setError("Please select a property type.");
      toast.error("Please select a property type.");
      return;
    }

    const approaches = details.farmland_details;
    if (property.propertyType === "agricultural" && !approaches?.use_direct_comparable && !approaches?.use_income_approach && !approaches?.use_cost_approach) {
      const message = "Select at least one farmland valuation approach before creating the report.";
      setError(message);
      toast.error(message);
      return;
    }

    try {
      if (property.mainImages.length === 0) {
        const msg = "Please add at least one property image.";
        setError(msg);
        toast.error(msg);
        return;
      }

      submissionRef.current = true;
      onSubmittingChange?.(true);
      setSubmitting(true);
      setError(null);
      setProgressPercent(0);

      const jobId =
        typeof crypto !== "undefined" && (crypto as any)?.randomUUID
          ? (crypto as any).randomUUID()
          : `cv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const inspector = {
        inspector_name: (user as any)?.username || (user as any)?.name || "",
        company_name: (user as any)?.companyName || "",
        contact_email: (user as any)?.contactEmail || user?.email || "",
        contact_phone: (user as any)?.contactPhone || "",
        credentials: "",
      };
      const payload: RealEstateDetails = {
        ...details,
        property_type: property.propertyType,
        report_dates: {
          report_date: details.report_dates.report_date,
          effective_date: details.report_dates.effective_date,
          inspection_date: details.report_dates.inspection_date,
        },
        inspector_info: inspector,
      };
      payload.progress_id = jobId;

      // Separate main images (for AI) and extra images (for report only)
      const mainImages: File[] = [...property.mainImages];
      const extraImages: File[] = [...property.extraImages];
      // Add map image to extra images if available
      if (mapImage) {
        extraImages.push(mapImage);
      }
      // Videos from property (if RealEstateSection supports videos)
      const videos: File[] = property.videoFile ? [property.videoFile] : [];

      const res = await RealEstateService.create(
        payload,
        mainImages,
        extraImages,
        videos,
        {
          onUploadProgress: (fraction: number) => {
            const pct = Math.max(0, Math.min(1, fraction));
            setProgressPercent((prev) => Math.max(prev, pct * 100));
          },
        }
      );

      const successMsg =
        res?.message ||
        "Your report is being processed. You will receive an email when it's ready.";
      toast.info(successMsg);
      // HTTP 202 confirms acceptance, not a completed preview or final report.
      setAccepted(true);
      onSubmittingChange?.(false);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("cv:report-created"));
      }
      onSuccess?.(res?.message);
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ||
        err?.message ||
        "Failed to create report";
      setError(msg);
      toast.error(msg);
    } finally {
      submissionRef.current = false;
      onSubmittingChange?.(false);
      setSubmitting(false);
    }
  }

  return (
    <form className="flex min-h-full flex-col" onSubmit={onSubmit} aria-busy={submitting}>
      {accepted ? (
        <div className="app-surface space-y-3 p-4" role="status">
          <h2 className="font-semibold text-[var(--app-text)]">Upload accepted</h2>
          <p className="text-sm text-[var(--app-text-muted)]">Your Real Estate preview is processing. You can leave this panel and check Previews when it is ready. Do not upload the same report again.</p>
          <button type="button" className="app-button app-button--secondary" onClick={onCancel}>Close</button>
        </div>
      ) : <>
      <fieldset disabled={submitting} hidden={submitting} className="min-w-0 border-0 p-0 m-0" inert={submitting}>
      <div className="relative flex min-h-full flex-col gap-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <div className="mb-2 flex items-start justify-between gap-3 rounded-lg border border-emerald-100 bg-[var(--app-panel)] p-4 shadow-sm">
          <div>
            <h2 className="text-lg font-semibold text-[var(--app-text)]">Real Estate Appraisal</h2>
            <p className="mt-1 text-sm text-[var(--app-text-muted)]">
              Capture property details, supporting files, photos, and valuation notes.
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Row 1: Property Type & Images + AI Assist */}
        <div className="grid gap-2 lg:grid-cols-2">
          <div className="rounded-lg border border-blue-100 bg-[var(--app-panel)] from-white via-blue-50/30 to-white p-3 shadow-sm">
            <RealEstateSection
              value={property}
              onChange={setProperty}
              maxImages={50}
              downloadPrefix={(details?.property_details?.address || "real-estate").replace(/[^a-zA-Z0-9_-]/g, "-")}
            />
          </div>
          <AIAssistSection
            specFiles={specFiles}
            onSpecChange={handleSpecChange}
            onRemoveSpecFile={removeSpecFile}
            onAnalyzeSpec={analyzeSpec}
            notesText={notesText}
            onNotesChange={setNotesText}
            onFillFromText={fillFromText}
            audioBlob={audioBlob}
            audioUrl={audioUrl}
            isRecording={isRecording}
            onStartRecording={startRecording}
            onStopRecording={stopRecording}
            onUseRecording={useRecording}
            onClearRecording={clearRecording}
            aiLoading={aiLoading}
          />
        </div>

        {/* Row 2: Property Details + Building Details */}
        <div className="grid gap-2 lg:grid-cols-2">
          <PropertyDetailsSection
            details={details}
            onChange={handleChange}
            onLanguageChange={(lang) => setDetails((prev) => ({ ...prev, language: lang }))}
          />
          <BuildingDetailsSection
            details={details}
            onChange={handleChange}
            onKnownIssuesChange={handleKnownIssuesChange}
          />
        </div>

        {/* Row 3: Farmland (if agricultural) + Map */}
        <div className="grid gap-2 lg:grid-cols-2">
          {details.property_type === "agricultural" ? (
            <FarmlandDetailsSection details={details} onChange={handleFarmlandChange} />
          ) : (
            <div className="hidden lg:block" />
          )}
          <MapUploadSection
            mapImage={mapImage}
            onMapImageChange={handleMapImageChange}
            onRemoveMapImage={removeMapImage}
          />
        </div>

        {/* Action Buttons */}
        <div className="sticky bottom-0 z-10 mt-auto flex flex-col gap-2 border-t border-[var(--app-border)] bg-[var(--app-panel)] px-1 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]  sm:flex-row sm:items-center">
          <button type="button" className="rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-xs text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)]" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button type="button" className="inline-flex items-center justify-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 hover:bg-emerald-100" onClick={saveInputs} disabled={submitting}>
            <Save className="h-3 w-3" />Save
          </button>
          <button type="submit" className="inline-flex items-center justify-center gap-1 rounded bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 sm:ml-auto" disabled={submitting}>
            {submitting ? "..." : "Create"}{!submitting && <Check className="h-3 w-3" />}
          </button>
        </div>

      </div>
      </fieldset>
        {submitting && (
          <div className="rounded-lg border border-blue-100 bg-[var(--app-panel)] p-3 shadow-sm">
            <p role="status" className="text-sm text-[var(--app-text)]">Uploading your report. Keep this page open until the server confirms it has accepted your files.</p>
            <progress aria-label="Real Estate upload progress" max={100} value={progressPercent} className="mt-3 h-2 w-full accent-[var(--app-accent)]" />
            <p className="mt-1 text-xs text-[var(--app-text-muted)]">{progressPercent >= 100 ? "Upload sent. Waiting for server confirmation…" : `${Math.round(progressPercent)}% uploaded`}</p>
          </div>
        )}
      </>}
    </form>
  );
}
