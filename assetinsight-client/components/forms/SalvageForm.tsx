"use client";

import { useEffect, useRef, useState } from "react";
import { useAuthContext } from "@/context/AuthContext";
import { SalvageService, SALVAGE_MAX_IMAGES, type SalvageDetails, type SalvageAssessmentInputs } from "@/services/salvage";
import { X, Upload, Camera, Download, LoaderCircle, CheckCircle2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import SalvageCamera from "./salvage/SalvageCamera";
import ImageAnnotatorModal from "./salvage/ImageAnnotatorModal";
import { salvageSystemText } from "@/lib/salvagePresentation";

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
  });

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
    const urls = images.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [images]);

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
  }

  function openAnnotator(index: number) {
    if (submissionInFlightRef.current) return;
    const f = images[index];
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
      const payload: SalvageDetails = {
        ...details,
        currency: "CAD",
        client_submission_id: submissionIdRef.current,
        report_date: details.report_date,
        date_received: details.date_received,
        next_report_due: details.next_report_due,
      };

      const res = await SalvageService.create(payload, images, {
        onUploadProgress: (fraction) => setUploadProgress(Math.round(fraction * 100)),
      });
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
        <p className="text-sm text-[var(--app-text)]">{uploadProgress}% uploaded · {images.length} photo{images.length === 1 ? "" : "s"}</p>
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

  return (
    <form className="flex min-h-full flex-col" onSubmit={onSubmit}>
      <div className="relative flex min-h-full flex-col gap-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <div className="flex items-start justify-between gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4 shadow-sm">
          <div>
            <h2 className="text-lg font-semibold text-[var(--app-text)]">Salvage Appraisal</h2>
            <p className="mt-1 text-sm text-[var(--app-text-muted)]">
              Record claim details and upload photos. Review the vehicle details read from your photos in the preview.
            </p>
          </div>
        </div>

        {!submitting && error && (
          <div role="alert" className="rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] p-3 text-sm text-[var(--app-danger)]">
            {error}
          </div>
        )}

        {/* Report & File Info */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-[var(--app-text)]">Report Details</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Report Date
              </label>
              <input
                type="date"
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.report_date}
                onChange={(e) => handleChange("report_date", e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Date Received
              </label>
              <input
                type="date"
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.date_received}
                onChange={(e) => handleChange("date_received", e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Next Report Due
              </label>
              <input
                type="date"
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.next_report_due}
                onChange={(e) =>
                  handleChange("next_report_due", e.target.value)
                }
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                File Number
              </label>
              <input
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.file_number}
                onChange={(e) => handleChange("file_number", e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Claim Number
              </label>
              <input
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.claim_number}
                onChange={(e) => handleChange("claim_number", e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Policy Number
              </label>
              <input
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.policy_number}
                onChange={(e) => handleChange("policy_number", e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Language
              </label>
              <select
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.language || "en"}
                onChange={(e) =>
                  handleChange("language", e.target.value as any)
                }
              >
                <option value="en">English</option>
                <option value="fr">Français</option>
                <option value="es">Español</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Assessment currency
              </label>
              <input
                type="text"
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-muted)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value="CAD — Canadian dollars"
                readOnly
                aria-label="Assessment currency"
              />
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-[var(--app-info-border,var(--app-border))] bg-[var(--app-info-soft)] p-3" aria-labelledby="salvage-photo-details-heading">
          <h3 id="salvage-photo-details-heading" className="text-sm font-semibold text-[var(--app-text)]">Vehicle details come from your photos</h3>
          <p className="mt-1 text-sm text-[var(--app-text-muted)]">Include a sharp VIN / serial plate photo, the dashboard odometer, engine labels and vehicle badges. We only show details readable in the uploaded images. Missing details show “Cannot find from image” in the preview, where you can enter or correct them.</p>
        </section>

        <section className="space-y-3" aria-labelledby="salvage-assessment-heading">
          <h3 id="salvage-assessment-heading" className="text-sm font-medium text-[var(--app-text)]">Canadian market & loss details</h3>
          <p className="text-xs text-[var(--app-text-muted)]">Enter verified facts; leave anything unknown blank. Market and date identify the comparable search area. A documented brand must match the registration or inspection evidence—it must not be guessed from damage.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {ASSESSMENT_CONTEXT_FIELDS.map((field) => (
              <div key={field.key}>
                <label htmlFor={`salvage-${field.key}`} className="block text-xs font-medium text-[var(--app-text-muted)]">{field.label}</label>
                <input id={`salvage-${field.key}`} type={field.type}
                  className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent)]"
                  value={details.assessment_inputs?.[field.key] ?? ""}
                  maxLength={field.type === "text" ? 300 : undefined}
                  placeholder={field.type === "text" ? "Unknown / not provided" : undefined}
                  onChange={(event) => handleAssessmentChange(field.key, event.target.value)} />
              </div>
            ))}
            {([['province', 'Market province / territory'], ['brandProvince', 'Brand document province / territory']] as const).map(([key, label]) => (
              <div key={key}>
                <label htmlFor={`salvage-${key}`} className="block text-xs font-medium text-[var(--app-text-muted)]">{label}</label>
                <select id={`salvage-${key}`} className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)]" value={details.assessment_inputs?.[key] ?? ""} onChange={(event) => handleAssessmentChange(key, event.target.value)}>
                  <option value="">Unknown</option>{PROVINCES.map((province) => <option key={province} value={province}>{province}</option>)}
                </select>
              </div>
            ))}
          </div>
          {([['condition', 'Pre-loss condition (if known)'], ['damageDescription', 'Observed damage']] as const).map(([key, label]) => (
            <div key={key}>
              <label htmlFor={`salvage-${key}`} className="block text-xs font-medium text-[var(--app-text-muted)]">{label}</label>
              <textarea id={`salvage-${key}`} rows={2} maxLength={key === "condition" ? 4000 : 8000}
                className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent)]"
                value={details.assessment_inputs?.[key] ?? ""} onChange={(event) => handleAssessmentChange(key, event.target.value)} />
            </div>
          ))}
        </section>

        {/* Parties & Contacts */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-[var(--app-text)]">Contacts</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Appraiser Name
              </label>
              <input
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.appraiser_name}
                onChange={(e) => handleChange("appraiser_name", e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Appraiser Phone
              </label>
              <input
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.appraiser_phone}
                onChange={(e) =>
                  handleChange("appraiser_phone", e.target.value)
                }
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Appraiser Email
              </label>
              <input
                type="email"
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.appraiser_email}
                onChange={(e) =>
                  handleChange("appraiser_email", e.target.value)
                }
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Adjuster Name
              </label>
              <input
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.adjuster_name}
                onChange={(e) => handleChange("adjuster_name", e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Insured Name
              </label>
              <input
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.insured_name}
                onChange={(e) => handleChange("insured_name", e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--app-text-muted)]">
                Company Name
              </label>
              <input
                className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
                value={details.company_name}
                onChange={(e) => handleChange("company_name", e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--app-text-muted)]">
              Company Address
            </label>
            <input
              className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
              value={details.company_address}
              onChange={(e) => handleChange("company_address", e.target.value)}
            />
          </div>
        </section>

        {/* Comments */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-[var(--app-text)]">Comments</h3>
          <div>
            <label className="block text-xs font-medium text-[var(--app-text-muted)]">
              Appraiser Comments
            </label>
            <textarea
              className="mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] shadow-inner ring-1  focus:outline-none focus:ring-2 focus:ring-blue-300"
              rows={3}
              value={details.appraiser_comments}
              onChange={(e) =>
                handleChange("appraiser_comments", e.target.value)
              }
            />
          </div>
        </section>

        {/* Images */}
        <section className="space-y-3 pb-4 sm:pb-6">
          <h3 className="text-sm font-medium text-[var(--app-text)]">Images (max {SALVAGE_MAX_IMAGES})</h3>
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
          <div className="rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] from-white/70 to-gray-50/50 p-5 text-center  shadow-inner">
            <Upload className="mx-auto h-8 w-8 text-[var(--app-text-muted)]" />
            <p className="mt-2 text-sm text-[var(--app-text-muted)]">Add images</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={images.length >= SALVAGE_MAX_IMAGES}
                className="app-button app-button--secondary"
              >
                <Upload className="h-4 w-4" />
                Select Images
              </button>
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                disabled={images.length >= SALVAGE_MAX_IMAGES}
                className="app-button app-button--secondary"
              >
                <Camera className="h-4 w-4" />
              Open Camera
            </button>
            <button
              type="button"
              onClick={downloadAllImagesZip}
              disabled={images.length === 0}
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--app-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--app-text)] border border-[var(--app-border)] shadow disabled:opacity-50 cursor-pointer"
              title="Download images as ZIP"
            >
              <Download className="h-4 w-4" />
              Download ZIP
            </button>
          </div>
          <p className="mt-1 text-xs text-[var(--app-text-muted)]">Up to {SALVAGE_MAX_IMAGES} images. All selected photos are included in your submission.</p>
        </div>
        <p className="text-xs text-[var(--app-text-muted)]">Selected: {images.length}/{SALVAGE_MAX_IMAGES} photos</p>
          {images.length > 0 && (
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2 shadow ring-1  ">
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {previews.map((src, idx) => (
                  <div
                    key={idx}
                    className="relative group overflow-hidden rounded-xl shadow-md transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-sm"
                  >
                    { }
                    <img
                      src={src}
                      alt={images[idx]?.name || `image-${idx + 1}`}
                      className="h-28 w-full object-cover cursor-crosshair"
                      onClick={() => openAnnotator(idx)}
                    />
                    {/* Edit overlay button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openAnnotator(idx);
                      }}
                      className="absolute left-1 bottom-1 rounded-full bg-black/70 px-2 py-1 text-[11px] text-white shadow-sm hover:bg-black/80 transition cursor-pointer"
                      aria-label="Edit image"
                      title="Edit"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      aria-label="Remove image"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeImage(idx);
                      }}
                      className="absolute right-1 top-1 rounded-full bg-black/70 p-1.5 text-white shadow-sm hover:bg-black/80 transition cursor-pointer"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <div className="sticky bottom-0 z-10 mt-auto flex flex-col gap-2 border-t border-[var(--app-border)] bg-[var(--app-panel)] px-1 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]  sm:flex-row sm:items-center">
          <button
            type="button"
            className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-2.5 text-sm text-[var(--app-text-muted)] shadow hover:bg-[var(--app-panel)] transition active:translate-y-0.5 cursor-pointer"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="app-button app-button--primary sm:ml-auto"
            disabled={submitting}
          >
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
        onClose={() => setAnnotOpen(false)}
        onSave={(annotated) => {
          if (annotIndex == null || submissionInFlightRef.current) return;
          setImages((prev) =>
            prev.map((f, i) => (i === annotIndex ? annotated : f))
          );
          setAnnotOpen(false);
        }}
      />
    </form>
  );
}
