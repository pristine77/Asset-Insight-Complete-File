import API from "@/lib/api";

export type ReportStatus = 'draft' | 'processing' | 'preview' | 'pending_approval' | 'approved' | 'declined' | 'error';
export type ReportWorkflowStage =
  | "preparing_preview"
  | "preview_ready"
  | "generating_files"
  | "awaiting_approval"
  | "awaiting_release"
  | "ready"
  | "error";

export interface AssetReport {
  _id: string;
  user: string;
  grouping_mode: string;
  imageUrls: string[];
  status: ReportStatus;
  files_generating?: boolean;
  files_regenerating?: boolean;
  job_id?: string;
  job_status?: "queued" | "processing" | "done" | "error";
  job_error?: string;
  generation_state?: "queued" | "processing" | "ready" | "error";
  workflow_stage?: ReportWorkflowStage;
  workflow_message?: string;
  workflow_progress_percent?: number;
  files_ready?: boolean;
  preview_available?: boolean;
  generation_progress?: {
    stage?: string;
    progressPercent?: number;
    message?: string;
    currentLot?: number;
    totalLots?: number;
    updatedAt?: string;
  };
  preview_data?: any;
  preview_files?: {
    pdf?: string;
    spec_pdf?: string;
    cr_docx?: string;
    docx?: string;
    excel?: string;
    images?: string;
  };
  preview_submitted_at?: string;
  preview_transferred_from?: string | null;
  preview_transferred_to?: string | null;
  preview_transferred_by?: string | null;
  preview_transferred_at?: string | null;
  approval_requested_at?: string;
  approval_processed_at?: string;
  decline_reason?: string;
  release_status?: "pending_release" | "released";
  release_assigned_to?: string | { _id?: string; email?: string; username?: string } | null;
  released_at?: string | null;
  downloadable?: boolean;
  lots: any[];
  client_name?: string;
  contract_no?: string;
  effective_date?: string;
  createdAt: string;
  updatedAt: string;
  is_merged_report?: boolean;
  merged_from_report_ids?: string[];
  merge_primary_report_id?: string | null;
  merge_conflicts?: AssetMergeConflict[];
}

export interface AssetMergeConflict {
  type: "duplicate_lot_number";
  lotNumber: string;
  lotIds: string[];
  sourceReportIds: string[];
}

export interface AssetMergeCandidate {
  id: string;
  isAnchor: boolean;
  eligible: boolean;
  disabledReason?: string | null;
  status: ReportStatus;
  clientName: string;
  contractNo: string;
  createdAt: string;
  lotCount: number;
  lotNumbers: string[];
  imageCount: number;
  thumbnailUrl?: string;
  isMergedReport?: boolean;
  owner?: {
    id: string;
    name: string;
    email: string;
  };
}

export interface AssetMergeCandidatesResponse {
  contractNo: string;
  contractKey: string;
  anchorReportId: string;
  candidates: AssetMergeCandidate[];
}

export interface AssetMergeResult {
  reportId: string;
  status: ReportStatus;
  resumed: boolean;
  is_merged_report: true;
  sourceCount: number;
  lotCount: number;
  merge_conflicts: AssetMergeConflict[];
  generation_state?: "queued" | "processing" | "ready" | "error";
}

export interface PreviewDataResponse {
  message: string;
  data: {
    status: ReportStatus;
    files_generating?: boolean;
    files_regenerating?: boolean;
    generation_state?: "queued" | "processing" | "ready" | "error";
    workflow_stage?: ReportWorkflowStage;
    workflow_message?: string;
    workflow_progress_percent?: number;
    files_ready?: boolean;
    job_status?: "queued" | "processing" | "done" | "error";
    job_error?: string;
    preview_data: any;
    preview_files?: {
      pdf?: string;
      spec_pdf?: string;
      cr_docx?: string;
      docx?: string;
      excel?: string;
      images?: string;
    };
    grouping_mode?: string;
    image_count?: number;
    imageUrls?: string[];
    decline_reason?: string;
    release_status?: "pending_release" | "released";
    release_assigned_to?: string | { _id?: string; email?: string; username?: string } | null;
    released_at?: string | null;
    downloadable?: boolean;
    reportId: string;
  };
}

export interface AssetCategorySpec {
  parentCategory: string;
  childCategory: string;
  fields: string[];
}

export const getAssetCategorySpecs = async (): Promise<{
  categories: string[];
  specs: AssetCategorySpec[];
}> => {
  const { data } = await API.get<{
    message: string;
    data: { categories: string[]; specs: AssetCategorySpec[] };
  }>(`/asset/category-specs`);
  return data.data;
};

/**
 * Get preview data for editing
 */
export const getPreviewData = async (reportId: string): Promise<PreviewDataResponse> => {
  const { data } = await API.get<PreviewDataResponse>(`/asset/${reportId}/preview`);
  return data;
};

/**
 * Update preview data with user edits
 */
export const updatePreviewData = async (
  reportId: string,
  previewData: any
): Promise<{ message: string; data: any; imageUrls?: string[]; image_count?: number; files_regeneration_queued?: boolean }> => {
  const { data } = await API.put<{ message: string; data: any; imageUrls?: string[]; image_count?: number; files_regeneration_queued?: boolean }>(
    `/asset/${reportId}/preview`,
    { preview_data: previewData }
  );
  return data;
};

export const uploadPreviewLotImages = async (
  reportId: string,
  lotKey: string | number,
  files: File[],
  previewData?: any,
  onProgress?: (progress: number) => void
): Promise<{
  message: string;
  data: {
    preview_data: any;
    preview_files?: AssetReport["preview_files"];
    imageUrls?: string[];
    image_count?: number;
    added?: Array<{ index: number; url: string; name: string }>;
    duplicatesSkipped?: number;
    lotIndex?: number;
    files_generating?: boolean;
    files_regenerating?: boolean;
  };
  files_regeneration_queued?: boolean;
}> => {
  const formData = new FormData();
  files.forEach((file) => formData.append("images", file));
  if (previewData) {
    formData.append("preview_data", JSON.stringify(previewData));
  }

  const { data } = await API.post(
    `/asset/${reportId}/preview/lots/${encodeURIComponent(String(lotKey))}/images`,
    formData,
    {
      headers: { "Content-Type": "multipart/form-data" },
      onUploadProgress: (event) => {
        if (!onProgress || !event.total) return;
        onProgress(Math.min(100, Math.round((event.loaded * 100) / event.total)));
      },
    }
  );
  return data;
};

export const refreshAssetSpecPdf = async (
  reportId: string
): Promise<{
  message: string;
  data: {
    spec_pdf: string;
    cr_docx?: string;
    preview_files?: AssetReport["preview_files"];
    preview_data?: any;
    imageUrls?: string[];
    image_count?: number;
  };
}> => {
  const { data } = await API.post<{
    message: string;
    data: {
      spec_pdf: string;
      cr_docx?: string;
      preview_files?: AssetReport["preview_files"];
      preview_data?: any;
      imageUrls?: string[];
      image_count?: number;
    };
  }>(`/asset/${reportId}/preview/spec-pdf`, {});
  return data;
};

/**
 * Submit report for admin approval
 */
export const submitForApproval = async (
  reportId: string,
  previewData?: any
): Promise<{ message: string; data: any }> => {
  const { data } = await API.post<{ message: string; data: any }>(
    `/asset/${reportId}/submit-approval`,
    previewData ? { preview_data: previewData } : {}
  );
  return data;
};

/**
 * Approve report (Admin only)
 */
export const approveReport = async (
  reportId: string
): Promise<{ message: string; data: any }> => {
  const { data } = await API.post<{ message: string; data: any }>(
    `/asset/${reportId}/approve`,
    {}
  );
  return data;
};

/**
 * Decline report (Admin only)
 */
export const declineReport = async (
  reportId: string,
  reason: string
): Promise<{ message: string; data: any }> => {
  const { data } = await API.post<{ message: string; data: any }>(
    `/asset/${reportId}/decline`,
    { reason }
  );
  return data;
};

/**
 * Get all asset reports
 */
export const getAssetReports = async (view?: "previews"): Promise<{ message: string; data: AssetReport[] }> => {
  const { data } = await API.get<{ message: string; data: AssetReport[] }>(`/asset`, view ? { params: { view }, timeout: 30000 } : undefined);
  return data;
};

export const getAssetMergeCandidates = async (
  reportId: string
): Promise<AssetMergeCandidatesResponse> => {
  const { data } = await API.get<{
    message: string;
    data: AssetMergeCandidatesResponse;
  }>(`/asset/${reportId}/merge-candidates`);
  return data.data;
};

export const mergeAssetReports = async (payload: {
  sourceReportIds: string[];
  primaryReportId: string;
  mergeRequestId: string;
}): Promise<AssetMergeResult> => {
  const { data } = await API.post<{ message: string; data: AssetMergeResult }>(
    "/asset/merge",
    payload
  );
  return data.data;
};

/**
 * Get submitted reports (pending_approval and approved)
 */
export const getSubmittedReports = async (): Promise<{ message: string; data: AssetReport[] }> => {
  const { data } = await API.get<{ message: string; data: AssetReport[] }>(`/asset/submitted`);
  return data;
};

export interface SubmittedPreviewDataResponse {
  message: string;
  data: {
    status: ReportStatus;
    files_generating?: boolean;
    files_regenerating?: boolean;
    preview_data: any;
    preview_files?: {
      pdf?: string;
      spec_pdf?: string;
      docx?: string;
      excel?: string;
      images?: string;
    };
    grouping_mode?: string;
    image_count?: number;
    imageUrls?: string[];
    reportId: string;
    createdAt: string;
    preview_submitted_at?: string;
    approval_requested_at?: string;
  };
}

/**
 * Get preview data for submitted reports (pending/approved)
 */
export const getSubmittedPreviewData = async (reportId: string): Promise<SubmittedPreviewDataResponse> => {
  const { data } = await API.get<SubmittedPreviewDataResponse>(`/asset/${reportId}/submitted-preview`);
  return data;
};

/**
 * Resubmit report - edit and regenerate files for approved/pending reports
 */
export const resubmitReport = async (
  reportId: string,
  previewData?: any
): Promise<{ message: string; data: any }> => {
  const { data } = await API.post<{ message: string; data: any }>(
    `/asset/${reportId}/resubmit`,
    previewData ? { preview_data: previewData } : {}
  );
  return data;
};

/**
 * Delete an asset report
 */
export const deleteAssetReport = async (
  reportId: string
): Promise<{ message: string; data: { reportId: string } }> => {
  const { data } = await API.delete<{ message: string; data: { reportId: string } }>(
    `/asset/${reportId}`
  );
  return data;
};
