"use client";

import { useEffect, useRef, useState } from "react";
import { useAuthContext } from "@/context/AuthContext";
import { SalvageService, SALVAGE_MAX_IMAGES, type SalvageDetails, type SalvageAssessmentInputs } from "@/services/salvage";
import { X, Upload, Camera, Download, LoaderCircle, CheckCircle2, Check, FileText, MapPin, MessageSquare, Users } from "lucide-react";
import { toast } from "@/components/ui/toast";
import SalvageCamera from "./salvage/SalvageCamera";
import ImageAnnotatorModal, { type AnnotatorAction, type DamageLoop } from "./salvage/ImageAnnotatorModal";
import { salvageSystemText } from "@/lib/salvagePresentation";
import CollapsibleSection from "./real-estate/CollapsibleSection";
import { FIELD_CLASS } from "./real-estate/Field";
import SalvageUnitsEditor, { salvageUnitPayload, type SalvageUnitDraft } from "./salvage/SalvageUnitsEditor";
import { ClipboardList, Layers } from "lucide-react";

/* Unit 1's details as the company's appraisal reports print them (owner, 2026-11-01). */
const UNIT_ONE_FIELDS = [
  ["unit_label", "Unit name", "Heavy Truck #807"], ["licence_plate", "Licence plate", ""], ["limit_of_insurance", "Limit of insurance", "$85,240.00"],
  ["coverage", "Coverage", "Collision"], ["deductible", "Deductible", "$1,000.00"], ["hours", "Hour / kilometre reading", ""],
] as const;

type Props = {
  onSuccess?: (message?: string) => void;
  onCancel?: () => void;
  onSubmittingChange?: (submitting: boolean) => void;
  onReportAccepted?: (reportId: string) => void;
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"] as const;
const ASSESSMENT_CONTEXT_FIELDS = [
  { key: "market", label: "City / local market", type: "text" },
  { key: "effectiveDate", label: "Effective valuation date", type: "date" },
  { key: "lossType", label: "Type / cause of loss", type: "text" },
  { key: "documentedBrand", label: "Documented vehicle brand", type: "text" },
] as const;
const initialAssessment = (): Partial<SalvageAssessmentInputs> => ({ province: null, market: null,
  effectiveDate: isoDate(new Date()), lossType: null, documentedBrand: null, brandProvince: null,
  condition: null, damageDescription: null, currency: "CAD" });

/**
 * A photo drawn on in the editor: the clean photo, what was drawn (to reopen it
 * editable), its damage loops (sent with the report) and the marked copy shown
 * as its thumbnail. The upload itself carries no loops; the server draws them.
 */
type PhotoEdit = { original: File; actions: AnnotatorAction[]; damageLoops: DamageLoop[]; displayFile: File };

/*
   One labelled field: the label and its control are siblings in their own
   wrapper, the label naming the control (htmlFor), in the app's field style.
*/
function SalvageField({ id, label, span, children }: { id: string; label: string; span?: "full"; children: React.ReactNode }) {
  return (
    <div className={`grid min-w-0 content-start gap-1.5 ${span === "full" ? "col-span-full" : ""}`}>
      <label htmlFor={id} className="text-[13px] font-semibold text-[var(--app-text)]">{label}</label>
      {children}
    </div>
  );
}

export default function SalvageForm({ onSuccess, onCancel, onSubmittingChange, onReportAccepted }: Props) {
  const { user } = useAuthContext();

  const [details, setDetails] = useState<SalvageDetails>({
    report_date: isoDate(new Date()),
    file_number: "",
    date_received: isoDate(new Date()),
    claim_number: "",
    policy_number: "",
    appraiser_name: (user as any)?.username || (user as any)?.name || "",
    appraiser_phone: (user as any)?.contactPhone || "",
    appraiser_email: (user as any)?.contactEmail || (user as any)?.email || "",
    adjuster_name: "",
    insured_name: "",
    company_name: (user as any)?.companyName || "",
    company_address: (user as any)?.companyAddress || "",
    appraiser_comments: "",
    next_report_due: isoDate(new Date()),
    language: "en",
    currency: "CAD",
    assessment_inputs: initialAssessment(),
    report_number: 1,
    follow_up: "",
    unit_label: "",
    licence_plate: "",
    limit_of_insurance: "",
    coverage: "",
    deductible: "",
    hours: "",
    pre_existing_damage: "",
  });
  // Units 2 onward, each with its own photos (owner, 2026-11-01: several units per report).
  const [units, setUnits] = useState<SalvageUnitDraft[]>([]);

  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submissionInFlightRef = useRef(false);
  const submissionIdRef = useRef<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [acceptedMessage, setAcceptedMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [annotOpen, setAnnotOpen] = useState(false);
  const [annotIndex, setAnnotIndex] = useState<number | null>(null);
  const [annotFile, setAnnotFile] = useState<File | null>(null);
  /*
    What was drawn on each photo, by position (owner, 2026-11-01: damage loops).
    The clean original is kept so reopening a photo shows its marks again,
    still editable, instead of drawing over marks already flattened into it.
  */
  const [photoEdits, setPhotoEdits] = useState<(PhotoEdit | undefined)[]>([]);

  // Upload acceptance is not report completion. Generation continues in the
  // backend after HTTP 202, with the existing email/approval workflow.
  useEffect(() => {
    if (!submitting) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [submitting]);

  function handleChange<K extends keyof SalvageDetails>(key: K, value: string) {
    if (submissionInFlightRef.current) return;
    setDetails((prev) => ({ ...prev, [key]: value }));
  }

  function handleAssessmentChange(key: keyof SalvageAssessmentInputs, raw: string) {
    if (submissionInFlightRef.current) return;
    const value = raw === "" ? null : raw;
    setDetails((prev) => ({ ...prev, assessment_inputs: { ...prev.assessment_inputs, [key]: value } }));
  }

  function handleImagesChange(files: FileList | null) {
    if (!files || submissionInFlightRef.current) return;
    const incoming = Array.from(files);
    setImages((prev) => {
      const combined = [...prev, ...incoming];
      if (combined.length > SALVAGE_MAX_IMAGES) {
        setError(`You can upload up to ${SALVAGE_MAX_IMAGES} images. Extra files were not added.`);
      } else {
        setError(null);
      }
      return combined.slice(0, SALVAGE_MAX_IMAGES);
    });
  }

  function addCapturedImages(files: File[]) {
    if (!files || files.length === 0 || submissionInFlightRef.current) return;
    setImages((prev) => {
      const combined = [...prev, ...files];
      if (combined.length > SALVAGE_MAX_IMAGES) {
        toast.warn(
          `Reached maximum of ${SALVAGE_MAX_IMAGES} images. Some captures were not added.`
        );
      }
      return combined.slice(0, SALVAGE_MAX_IMAGES);
    });
  }

  useEffect(() => {
    // Thumbnails show a marked photo with its loops; the upload stays clean.
    const urls = images.map((file, index) => URL.createObjectURL(photoEdits[index]?.displayFile || file));
    setPreviews(urls);
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [images, photoEdits]);

  async function downloadAllImagesZip() {
    try {
      if (images.length === 0) return;
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      for (const f of images) zip.file(f.name, f);
      const safePrefix = (
        details.file_number ||
        details.claim_number ||
        "salvage"
      ).replace(/[^a-zA-Z0-9_-]/g, "-");
      const blob = await zip.generateAsync({ type: "blob" });
      const zipName = `${safePrefix}-images-${Date.now()}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 2000);
    } catch {}
  }

  function removeImage(index: number) {
    if (submissionInFlightRef.current) return;
    setImages((prev) => prev.filter((_, i) => i !== index));
    setPhotoEdits((prev) => prev.filter((_, i) => i !== index));
  }

  function openAnnotator(index: number) {
    if (submissionInFlightRef.current) return;
    const f = photoEdits[index]?.original || images[index];
    if (!f) return;
    setAnnotIndex(index);
    setAnnotFile(f);
    setAnnotOpen(true);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // React state updates are not synchronous; the ref also blocks a second
    // submit dispatched before the disabled/loading render commits.
    if (submissionInFlightRef.current) return;

    // Basic required field checks mirroring backend required fields
    const required: (keyof SalvageDetails)[] = [
      "report_date",
      "file_number",
      "date_received",
      "claim_number",
      "policy_number",
      "appraiser_name",
      "appraiser_phone",
      "appraiser_email",
      "adjuster_name",
      "insured_name",
      "company_name",
      "company_address",
      "appraiser_comments",
      "next_report_due",
    ];

    const missing = required.filter((k) => !String(details[k] || "").trim());
    if (missing.length > 0) {
      const msg = `Please fill: ${missing.join(", ")}`;
      setError(msg);
      toast.error(msg);
      return;
    }

    submissionInFlightRef.current = true;
    let accepted = false;
    try {
      setSubmitting(true);
      onSubmittingChange?.(true);
      setUploadProgress(0);
      setError(null);

      submissionIdRef.current ||= crypto.randomUUID();
      const damageMarks = images.flatMap((_, photoIndex) => {
        const loops = photoEdits[photoIndex]?.damageLoops || [];
        return loops.length ? [{ photoIndex, loops }] : [];
      });
      const payload: SalvageDetails = {
        ...details,
        currency: "CAD",
        client_submission_id: submissionIdRef.current,
        ...(damageMarks.length ? { damage_marks: damageMarks } : {}),
        report_date: details.report_date,
        date_received: details.date_received,
        next_report_due: details.next_report_due,
        report_number: Math.min(20, Math.max(1, Math.round(Number(details.report_number) || 1))),
        ...(units.length ? { additional_units: units.map(salvageUnitPayload) } : {}),
      };

      const res = await SalvageService.create(payload, images, {
        onUploadProgress: (fraction) => setUploadProgress(Math.round(fraction * 100)),
      }, units.map((unit) => unit.images));
      accepted = true;
      const msg = res.jobId
        ? "Upload accepted. Your salvage report is processing in the background. Review the preview when it is ready, then submit to generate the report files."
        : salvageSystemText(res.message) || "Your salvage report was submitted. Check Reports for its status.";
      setAcceptedMessage(msg);
      toast.info(res.reportId && onReportAccepted ? "Upload accepted. Follow your report’s progress." : msg);
      try {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("cv:report-created"));
        }
      } catch {}
      // Clear local form state and notify parent to close
      setImages([]);
      setPreviews([]);
      setPhotoEdits([]);
      setUnits([]);
      onSubmittingChange?.(false);
      try {
        if (res.reportId && onReportAccepted) onReportAccepted(res.reportId);
        else onSuccess?.(msg);
      } catch (callbackError) {
        console.warn("Salvage upload was accepted but the form could not close", callbackError);
      }
    } catch (err: any) {
      const msg = salvageSystemText(
        err?.response?.data?.message ||
        err?.message ||
        "Failed to create report");
      setError(msg);
      toast.error(msg);
    } finally {
      // Accepted work remains locked until this form unmounts. Do not turn a
      // still-mounted success screen into another create of the same report.
      if (!accepted) submissionInFlightRef.current = false;
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  }

  if (submitting) {
    return (
      <section role="status" aria-live="polite" aria-label="Salvage upload status" className="app-surface mx-auto flex w-full max-w-lg flex-col items-center gap-4 p-6 text-center">
        <LoaderCircle className="h-8 w-8 animate-spin text-[var(--app-accent)] motion-reduce:animate-none" aria-hidden />
        <h2 className="text-lg font-semibold text-[var(--app-text)]">
          {uploadProgress < 100 ? "Uploading salvage report" : "Confirming your upload"}
        </h2>
        <progress aria-label="Report upload progress" value={uploadProgress} max={100} className="h-2 w-full accent-[var(--app-accent)]" />
        <p className="text-sm text-[var(--app-text)]">{uploadProgress}% uploaded · {images.length + units.reduce((sum, unit) => sum + unit.images.length, 0)} photo{images.length + units.reduce((sum, unit) => sum + unit.images.length, 0) === 1 ? "" : "s"}{units.length ? ` · ${units.length + 1} units` : ""}</p>
        <p className="text-sm text-[var(--app-text-muted)]">Keep this page open until the server accepts the upload. Closing now may lose this submission. Report generation and approval continue in the background afterward.</p>
      </section>
    );
  }

  if (acceptedMessage) {
    return (
      <section role="status" className="app-surface flex flex-col items-start gap-3 p-5">
        <CheckCircle2 className="h-7 w-7 text-[var(--app-success)]" aria-hidden />
        <h2 className="text-lg font-semibold text-[var(--app-text)]">Upload accepted</h2>
        <p className="text-sm text-[var(--app-text-muted)]">{acceptedMessage}</p>
        {onCancel ? <button type="button" className="app-button app-button--primary" onClick={onCancel}>Close</button> : null}
      </section>
    );
  }

  /*
    Layout (owner, 2026-11-01: "improve Salvage UI too", after the Real Estate
    form): numbered section cards in working order - 1 claim and report
    details, 2 photos (the vehicle details are read from them, so they come
    early), 3 market and loss details, 4 contacts, 5 comments - with the app's
    field and button styles. The fields drew an extra dark ring before; the
    drawer's header names the form, so the repeated title card is gone. Every
    field, label and value is as before.

    Full MCD Appraisals report (owner, 2026-11-01): 1 also takes the report
    number and follow-up; 3 "Unit details" (licence plate, limit of
    insurance, coverage, deductible, reading, pre-existing damage) and
    4 "More units" (each unit with its own photos and research) follow the
    photos; market, contacts and comments become 5 to 7.
  */
  return (
    <form className="flex min-h-full flex-col" onSubmit={onSubmit}>
      <div className="relative flex min-h-full flex-col gap-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {!submitting && error && (
          <div role="alert" className="app-alert app-alert--error">
            {error}
          </div>
        )}

        <CollapsibleSection step={1} title="Claim and report details" description="The file and claim this report is for, and its dates." icon={<FileText />}>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
            <SalvageField id="salvage-file-number" label="File Number">
              <input id="salvage-file-number" className={FIELD_CLASS} value={details.file_number} onChange={(e) => handleChange("file_number", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-claim-number" label="Claim Number">
              <input id="salvage-claim-number" className={FIELD_CLASS} value={details.claim_number} onChange={(e) => handleChange("claim_number", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-policy-number" label="Policy Number">
              <input id="salvage-policy-number" className={FIELD_CLASS} value={details.policy_number} onChange={(e) => handleChange("policy_number", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-report-date" label="Report Date">
              <input id="salvage-report-date" type="date" className={FIELD_CLASS} value={details.report_date} onChange={(e) => handleChange("report_date", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-date-received" label="Date Received">
              <input id="salvage-date-received" type="date" className={FIELD_CLASS} value={details.date_received} onChange={(e) => handleChange("date_received", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-next-report-due" label="Next Report Due">
              <input id="salvage-next-report-due" type="date" className={FIELD_CLASS} value={details.next_report_due} onChange={(e) => handleChange("next_report_due", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-report-number" label="Report number">
              <select id="salvage-report-number" className={FIELD_CLASS} value={String(details.report_number || 1)} onChange={(e) => handleChange("report_number", e.target.value)}>
                {["One", "Two", "Three", "Four", "Five", "Six"].map((word, index) => <option key={word} value={index + 1}>Report {word}</option>)}
              </select>
            </SalvageField>
            <SalvageField id="salvage-follow-up" label="Follow-up">
              <input id="salvage-follow-up" className={FIELD_CLASS} value={details.follow_up || ""} maxLength={300} placeholder="Upon Request" onChange={(e) => handleChange("follow_up", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-language" label="Language">
              <select id="salvage-language" className={FIELD_CLASS} value={details.language || "en"} onChange={(e) => handleChange("language", e.target.value as any)}>
                <option value="en">English</option>
                <option value="fr">Français</option>
                <option value="es">Español</option>
              </select>
            </SalvageField>
            <SalvageField id="salvage-currency" label="Assessment currency">
              <input id="salvage-currency" type="text" className={`${FIELD_CLASS} bg-[var(--app-panel-alt)] text-[var(--app-text-muted)]`} value="CAD — Canadian dollars" readOnly aria-label="Assessment currency" />
            </SalvageField>
          </div>
        </CollapsibleSection>

        <CollapsibleSection step={2} title="Photos" description={`Up to ${SALVAGE_MAX_IMAGES} photos. Choose Mark damage on a photo and draw a loop around each damaged area; the software inspects inside the loops closely.`} icon={<Camera />}>
          <div className="grid gap-3">
            <section className="rounded-lg border border-[var(--app-info-border,var(--app-border))] bg-[var(--app-info-soft)] px-3 py-2.5" aria-labelledby="salvage-photo-details-heading">
              <h3 id="salvage-photo-details-heading" className="text-sm font-semibold text-[var(--app-text)]">Vehicle details come from your photos</h3>
              <p className="mt-1 text-sm text-[var(--app-text-muted)]">Include a sharp VIN / serial plate photo, the dashboard odometer, engine labels and vehicle badges. We only show details readable in the uploaded images. Missing details show “Cannot find from image” in the preview, where you can enter or correct them.</p>
            </section>
            <input
              ref={fileInputRef}
              type="file"
              aria-label="Salvage images"
              accept="image/*"
              multiple
              onChange={(e) => {
                handleImagesChange(e.target.files);
                e.currentTarget.value = "";
              }}
              className="sr-only"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={images.length >= SALVAGE_MAX_IMAGES} className="app-button app-button--secondary">
                <Upload className="h-4 w-4" aria-hidden="true" />
                Select Images
              </button>
              <button type="button" onClick={() => setCameraOpen(true)} disabled={images.length >= SALVAGE_MAX_IMAGES} className="app-button app-button--secondary">
                <Camera className="h-4 w-4" aria-hidden="true" />
                Open Camera
              </button>
              <button type="button" onClick={downloadAllImagesZip} disabled={images.length === 0} className="app-button" title="Download images as ZIP">
                <Download className="h-4 w-4" aria-hidden="true" />
                Download ZIP
              </button>
              <p className="ml-auto text-xs font-semibold tabular-nums text-[var(--app-text-muted)]">Selected: {images.length}/{SALVAGE_MAX_IMAGES} photos</p>
            </div>
            {images.length > 0 ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {previews.map((src, idx) => (
                  <div key={idx} className="group relative overflow-hidden rounded-lg border border-[var(--app-border)]">
                    <img
                      src={src}
                      alt={images[idx]?.name || `image-${idx + 1}`}
                      className="h-24 w-full cursor-crosshair object-cover"
                      onClick={() => openAnnotator(idx)}
                    />
                    {photoEdits[idx]?.damageLoops.length ? (
                      <span className="absolute left-1.5 top-1.5 rounded-full bg-[#dc2626] px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm">
                        {photoEdits[idx]!.damageLoops.length} damage {photoEdits[idx]!.damageLoops.length === 1 ? "area" : "areas"}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openAnnotator(idx);
                      }}
                      className="absolute bottom-1.5 left-1.5 cursor-pointer rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm transition hover:bg-black/80"
                      aria-label="Edit image"
                      title="Mark damage or add notes"
                    >
                      {photoEdits[idx] ? "Edit marks" : "Mark damage"}
                    </button>
                    <button
                      type="button"
                      aria-label="Remove image"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeImage(idx);
                      }}
                      className="absolute right-1.5 top-1.5 cursor-pointer rounded-full bg-black/65 p-1.5 text-white shadow-sm transition hover:bg-[var(--app-danger)]"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-lg border border-dashed border-[var(--app-border-strong)] bg-[var(--app-panel-alt)] p-4">
                <Camera className="size-6 shrink-0 text-[var(--app-text-muted)]" aria-hidden="true" />
                <p className="text-sm text-[var(--app-text-muted)]">No photos yet. Select images or open the camera.</p>
              </div>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection step={3} title="Unit details" description="As the appraisal report prints them for this unit. Leave anything that does not apply blank; it prints as N/A." icon={<ClipboardList />} optional>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
            {UNIT_ONE_FIELDS.map(([key, label, placeholder]) => (
              <SalvageField key={key} id={`salvage-${key}`} label={label}>
                <input id={`salvage-${key}`} className={FIELD_CLASS} value={String(details[key] ?? "")} placeholder={placeholder || undefined} onChange={(e) => handleChange(key, e.target.value)} />
              </SalvageField>
            ))}
            <SalvageField id="salvage-pre-existing-damage" label="Pre-existing damage" span="full">
              <textarea id="salvage-pre-existing-damage" rows={2} className={`${FIELD_CLASS} resize-y`} value={details.pre_existing_damage || ""} placeholder="None" onChange={(e) => handleChange("pre_existing_damage", e.target.value)} />
            </SalvageField>
          </div>
        </CollapsibleSection>

        <CollapsibleSection step={4} title="More units" description="One report can cover several units, such as a truck and its trailers or a row of grain bins. Each unit gets its own pages, value and reserve, and a total on the summary." icon={<Layers />} optional>
          <SalvageUnitsEditor units={units} onChange={setUnits} disabled={submitting} />
        </CollapsibleSection>

        <CollapsibleSection step={5} title="Canadian market & loss details" description="Enter verified facts; leave anything unknown blank. Market and date identify the comparable search area. A documented brand must match the registration or inspection evidence—it must not be guessed from damage." icon={<MapPin />}>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
            {ASSESSMENT_CONTEXT_FIELDS.map((field) => (
              <SalvageField key={field.key} id={`salvage-${field.key}`} label={field.label}>
                <input id={`salvage-${field.key}`} type={field.type}
                  className={FIELD_CLASS}
                  value={details.assessment_inputs?.[field.key] ?? ""}
                  maxLength={field.type === "text" ? 300 : undefined}
                  placeholder={field.type === "text" ? "Unknown / not provided" : undefined}
                  onChange={(event) => handleAssessmentChange(field.key, event.target.value)} />
              </SalvageField>
            ))}
            {([['province', 'Market province / territory'], ['brandProvince', 'Brand document province / territory']] as const).map(([key, label]) => (
              <SalvageField key={key} id={`salvage-${key}`} label={label}>
                <select id={`salvage-${key}`} className={FIELD_CLASS} value={details.assessment_inputs?.[key] ?? ""} onChange={(event) => handleAssessmentChange(key, event.target.value)}>
                  <option value="">Unknown</option>{PROVINCES.map((province) => <option key={province} value={province}>{province}</option>)}
                </select>
              </SalvageField>
            ))}
            {([['condition', 'Pre-loss condition (if known)'], ['damageDescription', 'Observed damage']] as const).map(([key, label]) => (
              <SalvageField key={key} id={`salvage-${key}`} label={label} span="full">
                <textarea id={`salvage-${key}`} rows={2} maxLength={key === "condition" ? 4000 : 8000}
                  className={`${FIELD_CLASS} resize-y`}
                  value={details.assessment_inputs?.[key] ?? ""} onChange={(event) => handleAssessmentChange(key, event.target.value)} />
              </SalvageField>
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection step={6} title="Contacts" description="The appraiser, adjuster, insured and company named in the report." icon={<Users />}>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
            <SalvageField id="salvage-appraiser-name" label="Appraiser Name">
              <input id="salvage-appraiser-name" className={FIELD_CLASS} value={details.appraiser_name} onChange={(e) => handleChange("appraiser_name", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-appraiser-phone" label="Appraiser Phone">
              <input id="salvage-appraiser-phone" type="tel" className={FIELD_CLASS} value={details.appraiser_phone} onChange={(e) => handleChange("appraiser_phone", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-appraiser-email" label="Appraiser Email">
              <input id="salvage-appraiser-email" type="email" className={FIELD_CLASS} value={details.appraiser_email} onChange={(e) => handleChange("appraiser_email", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-adjuster-name" label="Adjuster Name">
              <input id="salvage-adjuster-name" className={FIELD_CLASS} value={details.adjuster_name} onChange={(e) => handleChange("adjuster_name", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-insured-name" label="Insured Name">
              <input id="salvage-insured-name" className={FIELD_CLASS} value={details.insured_name} onChange={(e) => handleChange("insured_name", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-company-name" label="Company Name">
              <input id="salvage-company-name" className={FIELD_CLASS} value={details.company_name} onChange={(e) => handleChange("company_name", e.target.value)} />
            </SalvageField>
            <SalvageField id="salvage-company-address" label="Company Address" span="full">
              <input id="salvage-company-address" className={FIELD_CLASS} value={details.company_address} onChange={(e) => handleChange("company_address", e.target.value)} />
            </SalvageField>
          </div>
        </CollapsibleSection>

        <CollapsibleSection step={7} title="Comments" description="Anything the reader of the report should know." icon={<MessageSquare />} optional>
          <SalvageField id="salvage-appraiser-comments" label="Appraiser Comments">
            <textarea id="salvage-appraiser-comments" className={`${FIELD_CLASS} resize-y`} rows={3} value={details.appraiser_comments} onChange={(e) => handleChange("appraiser_comments", e.target.value)} />
          </SalvageField>
        </CollapsibleSection>

        <div className="sticky bottom-0 z-10 mt-auto flex flex-col-reverse gap-2 border-t border-[var(--app-border)] bg-[var(--app-panel)] pt-3 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:flex-row sm:items-center">
          <button type="button" className="app-button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <span className="hidden text-xs tabular-nums text-[var(--app-text-muted)] sm:ml-auto sm:inline">{images.length} photo{images.length === 1 ? "" : "s"} selected</span>
          <button type="submit" className="app-button app-button--primary min-w-36" disabled={submitting}>
            {!submitting && <Check className="size-4" aria-hidden="true" />}
            {submitting ? "Creating..." : "Create Report"}
          </button>
        </div>
      </div>
      {/* Camera overlay for capture */}
      <SalvageCamera
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onAdd={(files) => addCapturedImages(files)}
        downloadPrefix={(
          details.file_number ||
          details.claim_number ||
          "salvage"
        ).replace(/[^a-zA-Z0-9_-]/g, "-")}
        maxCount={SALVAGE_MAX_IMAGES - images.length}
      />
      {/* Annotator modal for drawing/text */}
      <ImageAnnotatorModal
        open={annotOpen}
        file={annotFile}
        defaultMode="damage"
        initialActions={annotIndex != null ? photoEdits[annotIndex]?.actions : undefined}
        onClose={() => setAnnotOpen(false)}
        onSave={(uploadFile, edit) => {
          if (annotIndex == null || submissionInFlightRef.current || !annotFile || !uploadFile) return;
          const original = annotFile;
          // Nothing drawn: the clean photo goes up and the photo has no marks.
          const marked = edit.actions.length > 0;
          setImages((prev) => prev.map((f, i) => (i === annotIndex ? (marked ? uploadFile : original) : f)));
          setPhotoEdits((prev) => {
            const next = [...prev];
            next[annotIndex] = marked
              ? { original, actions: edit.actions, damageLoops: edit.damageLoops, displayFile: edit.displayFile || uploadFile }
              : undefined;
            return next;
          });
          setAnnotOpen(false);
        }}
      />
    </form>
  );
}
