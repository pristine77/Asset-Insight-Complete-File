import api from './api';
import { assertReportImageLimit, SALVAGE_IMAGE_LIMIT, REPORT_UPLOAD_TIMEOUT_MS } from './reportUploadPolicy';
import type { SalvageAssessmentInputs, SalvageAssessmentV2 } from '../types/salvageAssessment';
import type { SalvageReportContext, SalvageReportEnrichment } from '../types/salvageReportEnrichment';
export type { SalvageAssessmentInputs, SalvageAssessmentV2, SalvageComparableEvidence, SalvageReference } from '../types/salvageAssessment';

// Types
export interface SalvageDetails {
  report_date: string;
  file_number: string;
  date_received: string;
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
  next_report_due: string;
  language?: 'en' | 'fr' | 'es';
  currency?: string;
  client_submission_id?: string;
  assessment_inputs?: Partial<SalvageAssessmentInputs>;
}

export type SalvageSnapshot = Record<string, any> & {
  readonly assessment?: SalvageAssessmentV2;
  assessment_inputs?: Partial<SalvageAssessmentInputs>;
  readonly report_enrichment?: SalvageReportEnrichment;
  report_context?: SalvageReportContext;
};
export interface SalvageReport {
  _id: string;
  reportId?: string;
  file_number?: string;
  status: 'processing' | 'preview' | 'pending_approval' | 'approved' | 'declined' | 'error' | 'cancelled';
  currency?: string;
  valuation?: SalvageSnapshot;
  imageUrls?: string[];
  preview_data?: SalvageSnapshot;
  revision: number;
  createdAt?: string;
  generation_state?: 'queued' | 'processing' | 'ready' | 'error' | 'cancelled';
  preview_available?: boolean;
  can_cancel?: boolean;
  workflow_steps?: Array<{ key: string; label: string; status: 'pending' | 'active' | 'completed' | 'error' | 'cancelled' }>;
  workflow_stage?: string;
  workflow_message?: string;
  workflow_progress_percent?: number;
  files_ready?: boolean;
  files_generating?: boolean;
  job_status?: string;
  job_error?: string;
  job_id?: string;
  downloadable?: boolean;
  download_access?: unknown;
  files?: Partial<Record<'pdf' | 'docx' | 'xlsx' | 'images', string>>;
}

export const isSalvageGenerating = (report: SalvageReport): boolean =>
  report.status === 'processing' || report.files_generating === true ||
  ['queued', 'processing'].includes(report.generation_state || '') ||
  ['preparing_preview', 'generating_files'].includes(report.workflow_stage || '');

export const salvageSubmissionAction = (report: SalvageReport): 'submit' | 'resubmit' =>
  ['pending_approval', 'approved', 'declined'].includes(report.status) ? 'resubmit' : 'submit';

export interface SalvageCreateResponse {
  message: string;
  jobId?: string;
  reportId?: string;
  phase?: 'upload' | 'processing' | 'done' | 'error';
}

export interface ProgressData {
  id: string;
  phase: 'upload' | 'processing' | 'done' | 'error';
  serverProgress01: number;
  steps: Array<{
    key: string;
    label: string;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
  }>;
  message?: string;
  result?: { reportId: string; reportType: 'Salvage'; status: SalvageReport['status'] };
}

// Helper to create FormData for images
const createFormData = (
  details: SalvageDetails,
  images: Array<{ uri: string; name: string; type: string }>
): FormData => {
  assertReportImageLimit(images, SALVAGE_IMAGE_LIMIT, 'Salvage');
  const formData = new FormData();
  formData.append('details', JSON.stringify(details));

  images.forEach((image, index) => {
    formData.append('images', {
      uri: image.uri,
      name: image.name || `image_${index}.jpg`,
      type: image.type || 'image/jpeg',
    } as any);
  });

  return formData;
};

// Match the backend's owner-editable surface. Provider evidence, media, jobs and
// ownership stay server-owned, even when a full canonical preview is passed in.
const EDITABLE_FIELDS = [
  'report_date', 'file_number', 'date_received', 'claim_number', 'policy_number',
  'date_of_loss', 'reported_loss_type', 'appraiser_name', 'appraiser_phone',
  'appraiser_email', 'item_type', 'year', 'make', 'item_model', 'vin',
  'adjuster_name', 'insured_name', 'company_name', 'company_address',
  'cause_of_loss_summary', 'appraiser_comments', 'next_report_due', 'language',
  'currency', 'valuation', 'repair_items', 'labour_breakdown', 'procurement_notes',
  'assumptions', 'safety_concerns', 'priority_level', 'labour_rate_default',
  'item_condition', 'damage_description', 'inspection_comments', 'is_repairable',
  'repair_facility', 'repair_facility_comments', 'actual_cash_value', 'replacement_cost',
  'recommended_reserve', 'repair_estimate', 'assessment_inputs', 'report_context',
] as const;

export function salvageEditableData(data: SalvageSnapshot): SalvageSnapshot {
  return Object.fromEntries(EDITABLE_FIELDS.filter((key) => key in data).map((key) => [key, data[key]]));
}

const salvageService = {
  /**
   * Create a new salvage report
   */
  async create(
    details: SalvageDetails,
    images: Array<{ uri: string; name: string; type: string }>,
    onUploadProgress?: (progress: number) => void,
    signal?: AbortSignal
  ): Promise<SalvageCreateResponse> {
    const formData = createFormData(details, images);

    const response = await api.post<SalvageCreateResponse>('/salvage', formData, {
      timeout: REPORT_UPLOAD_TIMEOUT_MS,
      signal,
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        if (onUploadProgress && progressEvent.total) {
          const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onUploadProgress(progress);
        }
      },
    });

    return response.data;
  },

  /**
   * Get progress of a salvage report job
   */
  async getProgress(jobId: string): Promise<ProgressData> {
    const response = await api.get<ProgressData>(`/salvage/progress/${jobId}`);
    return response.data;
  },

  async list(view?: 'previews'): Promise<SalvageReport[]> {
    const response = await (view ? api.get<{ data: SalvageReport[] }>('/salvage', { params: { view } }) : api.get<{ data: SalvageReport[] }>('/salvage'));
    return response.data.data;
  },

  async getPreview(id: string): Promise<SalvageReport> {
    const response = await api.get<{ data: SalvageReport }>(`/salvage/${encodeURIComponent(id)}/preview`);
    return response.data.data;
  },

  async savePreview(id: string, data: SalvageSnapshot, baseRevision: number): Promise<SalvageReport> {
    const response = await api.patch<{ data: SalvageReport }>(`/salvage/${encodeURIComponent(id)}/preview`, { data: salvageEditableData(data), baseRevision });
    return response.data.data;
  },

  async submit(report: SalvageReport): Promise<SalvageCreateResponse & { data: SalvageReport }> {
    const action = salvageSubmissionAction(report);
    const response = await api.post(`/salvage/${encodeURIComponent(report._id)}/${action}`, { baseRevision: report.revision });
    return response.data;
  },

  async retry(id: string, baseRevision?: number): Promise<SalvageCreateResponse & { data: SalvageReport }> {
    const response = await api.post(`/salvage/${encodeURIComponent(id)}/retry`, ...(baseRevision === undefined ? [] : [{ baseRevision }]));
    return response.data;
  },

  async cancel(id: string, baseRevision: number, jobId: string): Promise<{ data: SalvageReport }> {
    const response = await api.post(`/salvage/${encodeURIComponent(id)}/cancel`, { baseRevision, jobId });
    return response.data;
  },

  async research(id: string, baseRevision: number, clientRequestId: string): Promise<SalvageCreateResponse & { data: SalvageReport }> {
    const response = await api.post(`/salvage/${encodeURIComponent(id)}/research`, {
      baseRevision, client_request_id: clientRequestId,
    });
    return response.data;
  },
};

export default salvageService;
