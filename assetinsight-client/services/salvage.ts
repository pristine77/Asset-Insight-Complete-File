import API from "@/lib/api";
import type { AxiosProgressEvent } from "axios";
import type { SalvageAssessmentInputs, SalvageAssessmentV2 } from "@/lib/salvageAssessment";
import { editableSalvageReportContext, type SalvageReportContext, type SalvageReportEnrichment } from "@/lib/salvageReportEnrichment";
export type { SalvageAssessmentInputs, SalvageAssessmentV2, SalvageComparableEvidence, SalvageReference } from "@/lib/salvageAssessment";

// Matches the shared web/mobile backend multipart limit.
export const SALVAGE_MAX_IMAGES = 50;

export type SalvageDetails = {
  report_date: string; // ISO date string (yyyy-mm-dd)
  file_number: string;
  date_received: string; // ISO date string
  claim_number: string;
  policy_number: string;
  appraiser_name: string;
  appraiser_phone: string;
  appraiser_email: string;
  adjuster_name: string;
  insured_name: string;
  company_name: string;
  company_address: string;
  appraiser_comments: string;
  next_report_due: string; // ISO date string
  language?: 'en' | 'fr' | 'es';
  currency?: string; // ISO code, e.g., CAD, USD, EUR
  // Background progress id (optional, server will use it if provided)
  progress_id?: string;
  client_submission_id?: string;
  assessment_inputs?: Partial<SalvageAssessmentInputs>;
};

export type SalvageCreateResponse = {
  message: string;
  // Background job ack
  jobId?: string;
  reportId?: string;
  phase?: "upload" | "processing" | "done" | "error";
  // Legacy immediate response fields (if any)
  filePath?: string;
  pdfPath?: string;
  docxPath?: string;
  xlsxPath?: string;
};

export type CreateOptions = {
  onUploadProgress?: (fraction: number) => void;
};

export type SalvagePreviewData = Record<string, unknown> & {
  readonly assessment?: SalvageAssessmentV2;
  assessment_inputs?: Partial<SalvageAssessmentInputs>;
  readonly report_enrichment?: SalvageReportEnrichment;
  report_context?: SalvageReportContext;
};
export type SalvageReport = {
  _id: string;
  reportId?: string;
  file_number: string;
  status: "processing" | "preview" | "pending_approval" | "approved" | "declined" | "error" | "cancelled";
  revision: number;
  createdAt: string;
  updatedAt?: string;
  currency?: string;
  valuation?: Record<string, unknown>;
  imageUrls: string[];
  preview_data: SalvagePreviewData;
  generation_state?: "queued" | "processing" | "ready" | "error" | "cancelled";
  workflow_stage?: string;
  workflow_message?: string;
  workflow_progress_percent?: number;
  files_ready?: boolean;
  files_generating?: boolean;
  job_status?: string;
  job_error?: string;
  job_id?: string;
  decline_reason?: string;
  downloadable?: boolean;
  download_access?: unknown;
  release_status?: "pending_release" | "released";
  files?: Partial<Record<"pdf" | "docx" | "xlsx" | "images", string>>;
  preview_available?: boolean;
  can_cancel?: boolean;
  workflow_steps?: Array<{ key: string; label: string; status: "pending" | "active" | "completed" | "error" | "cancelled" }>;
};

export function salvageIsProcessing(report: SalvageReport): boolean {
  if (report.status === "cancelled" || report.generation_state === "cancelled" || report.workflow_stage === "cancelled" || report.workflow_stage === "stopped") return false;
  if (report.workflow_stage === "error" || report.generation_state === "error") return false;
  return report.files_generating === true || report.status === "processing" ||
    ["queued", "processing"].includes(report.generation_state || "") ||
    ["preparing_preview", "generating_files"].includes(report.workflow_stage || "");
}

export function salvagePreviewPath(id: string): string {
  return `/salvage/preview/${encodeURIComponent(id)}`;
}

export function salvageStatusPath(id: string): string {
  return `/salvage/status/${encodeURIComponent(id)}`;
}

export function salvageHasPreview(report: SalvageReport): boolean {
  if (typeof report.preview_available === "boolean") return report.preview_available;
  // Legacy servers have no explicit flag: never infer readiness from intake fields or photos.
  return !salvageIsProcessing(report) && ["preview", "declined", "pending_approval", "approved"].includes(report.status)
    && Object.keys(report.preview_data || {}).length > 0;
}

// Send only report-editable fields. Ownership, workflow, media and AI evidence
// are server-owned even when present in a legacy flat preview snapshot.
const EDITABLE_FIELDS = [
  "report_date", "file_number", "date_received", "claim_number", "policy_number",
  "date_of_loss", "reported_loss_type", "appraiser_name", "appraiser_phone",
  "appraiser_email", "item_type", "year", "make", "item_model", "vin",
  "adjuster_name", "insured_name", "company_name", "company_address",
  "cause_of_loss_summary", "appraiser_comments", "next_report_due", "language",
  "currency", "valuation", "repair_items", "labour_breakdown", "procurement_notes",
  "assumptions", "safety_concerns", "priority_level", "labour_rate_default",
  "item_condition", "damage_description", "inspection_comments", "is_repairable",
  "repair_facility", "repair_facility_comments", "actual_cash_value", "replacement_cost",
  "recommended_reserve", "repair_estimate", "assessment_inputs", "report_context",
] as const;

export function salvageEditableData(data: SalvagePreviewData): SalvagePreviewData {
  return Object.fromEntries(EDITABLE_FIELDS.filter((key) => key in data).map((key) =>
    [key, key === "report_context" ? editableSalvageReportContext(data[key]) : data[key]]));
}

export const SalvageService = {
  async getReports(view?: "previews"): Promise<{ data: SalvageReport[] }> {
    const { data } = await (view ? API.get<{ data: SalvageReport[] }>("/salvage", { params: { view }, timeout: 30000 }) : API.get<{ data: SalvageReport[] }>("/salvage"));
    return data;
  },
  async getPreview(id: string): Promise<{ data: SalvageReport }> {
    const { data } = await API.get<{ data: SalvageReport }>(`/salvage/${encodeURIComponent(id)}/preview`);
    return data;
  },
  async savePreview(id: string, preview: SalvagePreviewData, baseRevision: number): Promise<{ data: SalvageReport }> {
    const { data } = await API.patch<{ data: SalvageReport }>(`/salvage/${encodeURIComponent(id)}/preview`, {
      data: salvageEditableData(preview), baseRevision,
    });
    return data;
  },
  async submit(id: string, baseRevision: number, resubmit = false): Promise<{ data: SalvageReport }> {
    const { data } = await API.post<{ data: SalvageReport }>(`/salvage/${encodeURIComponent(id)}/${resubmit ? "resubmit" : "submit"}`, { baseRevision });
    return data;
  },
  async retry(id: string, baseRevision?: number): Promise<{ data: SalvageReport }> {
    const { data } = await API.post<{ data: SalvageReport }>(`/salvage/${encodeURIComponent(id)}/retry`, baseRevision === undefined ? {} : { baseRevision });
    return data;
  },
  async cancel(id: string, baseRevision: number, jobId: string): Promise<{ data: SalvageReport }> {
    const { data } = await API.post<{ data: SalvageReport }>(`/salvage/${encodeURIComponent(id)}/cancel`, {
      baseRevision, jobId,
    });
    return data;
  },
  async research(id: string, baseRevision: number, clientRequestId: string): Promise<{ data: SalvageReport }> {
    const { data } = await API.post<{ data: SalvageReport }>(`/salvage/${encodeURIComponent(id)}/research`, {
      baseRevision, client_request_id: clientRequestId,
    });
    return data;
  },
  async create(details: SalvageDetails, images: File[], options?: CreateOptions): Promise<SalvageCreateResponse> {
    if (images.length > SALVAGE_MAX_IMAGES) {
      throw new Error(`Salvage reports support up to ${SALVAGE_MAX_IMAGES} images. Remove extra images before submitting.`);
    }
    const fd = new FormData();
    fd.append("details", JSON.stringify(details));
    images.forEach((file) => fd.append("images", file));

    const { data } = await API.post<SalvageCreateResponse>("/salvage", fd, {
      onUploadProgress: (e: AxiosProgressEvent) => {
        if (!options?.onUploadProgress) return;
        let fraction = typeof e.progress === "number" ? e.progress : 0;
        if (!fraction && typeof e.loaded === "number" && typeof e.total === "number" && e.total > 0) {
          fraction = e.loaded / e.total;
        }
        options.onUploadProgress(Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0);
      },
    });
    return data;
  },
  async progress(id: string) {
    const { data } = await API.get(`/salvage/progress/${id}`);
    return data as {
      id: string;
      phase: "upload" | "processing" | "done" | "error";
      serverProgress01: number;
      steps: Array<{ key: string; label: string; startedAt?: string; endedAt?: string; durationMs?: number }>;
      message?: string;
      result?: { reportId: string; reportType: "Salvage"; status: string };
    };
  },
};
