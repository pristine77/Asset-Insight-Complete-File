import API from "@/lib/api";
import { assertAuthSessionCurrent, captureAuthSession, isAuthSessionCurrent } from "@/lib/auth-storage";
import type { AxiosProgressEvent } from "axios";
import type { ReportWorkflowStage } from "./assets";
import { isUploadSessionUnsupportedError, uploadReportFilesDirectToR2 } from "./directUpload";
import { assertReportUploadAccepted } from "./reportTransferErrors";
import { lotListingDirectUploadFiles, submissionFilesFromLots, type SubmissionLotMedia } from "./uploadJobFiles";

export interface LotListingLot {
  lot_id: string;
  lot_number: string | number;
  title?: string;
  description?: string;
  details?: string;
  damage_analysis?: string;
  condition_report_specs?: Record<string, string>;
  lotted_by?: string;
  condition_report_selections?: {
    condition?: string;
    completeness?: string;
    legal?: string;
  };
  estimated_value?: string;
  quantity?: number;
  must_take?: boolean;
  categories?: string;
  serial_number?: string;
  show_on_website?: boolean;
  close_date?: string;
  bid_increment?: number;
  location?: string;
  opening_bid?: number;
  latitude?: number;
  longitude?: number;
  item_condition?: string;
  image_indexes: number[];
  image_url?: string;
  image_urls?: string[];
  extra_image_indexes?: number[];
  extra_image_urls?: string[];
  video_urls?: string[];
  cover_index?: number;
  sub_mode?: string;
  tags?: string[];
}

export interface LotListingPreviewFiles {
  spec_pdf?: string;
  cr_docx?: string;
  excel?: string;
  images?: string;
}

export interface LotListing {
  _id: string;
  user: string;
  status: "processing" | "preview" | "pending_approval" | "approved" | "declined" | "error";
  job_id?: string;
  job_status?: "queued" | "processing" | "done" | "error";
  job_error?: string;
  error_message?: string;
  generation_state?: "queued" | "processing" | "ready" | "error";
  workflow_stage?: ReportWorkflowStage;
  workflow_message?: string;
  workflow_progress_percent?: number;
  files_ready?: boolean;
  preview_available?: boolean;
  files_generating?: boolean;
  files_regenerating?: boolean;
  generation_progress?: {
    stage?: string;
    progressPercent?: number;
    message?: string;
    currentLot?: number;
    totalLots?: number;
    updatedAt?: string;
  };
  include_damage_analysis?: boolean;
  watermark_images?: boolean;
  activity_id?: string;
  progress?: {
    phase: string;
    percent: number;
    message?: string;
  };
  details?: {
    contract_no?: string;
    sales_date?: string;
    location?: string;
    latitude?: number;
    longitude?: number;
    currency?: string;
    include_damage_analysis?: boolean;
    watermark_images?: boolean;
    valuation_methods?: Array<"FML" | "TKV" | "OLV" | "FLV">;
  };
  lots?: LotListingLot[];
  imageUrls?: string[];
  videoUrls?: string[];
  preview_data?: {
    contract_no?: string;
    sales_date?: string;
    location?: string;
    latitude?: number;
    longitude?: number;
    currency?: string;
    include_damage_analysis?: boolean;
    watermark_images?: boolean;
    valuation_methods?: Array<"FML" | "TKV" | "OLV" | "FLV">;
    lots?: LotListingLot[];
    videoUrls?: string[];
    total_value?: number;
  };
  preview_files?: LotListingPreviewFiles;
  files?: LotListingPreviewFiles;
  decline_reason?: string;
  release_status?: "pending_release" | "released";
  release_assigned_to?: string | { _id?: string; email?: string; username?: string } | null;
  released_at?: string | null;
  downloadable?: boolean;
  preview_submitted_at?: string;
  preview_transferred_from?: string | null;
  preview_transferred_to?: string | null;
  preview_transferred_by?: string | null;
  preview_transferred_at?: string | null;
  approval_requested_at?: string;
  generation_target_status?: "preview" | "pending_approval" | "approved";
  createdAt: string;
  updatedAt: string;
}

export interface LotListingProgress {
  phase: string;
  percent?: number;
  serverProgress01?: number;
  message?: string;
  stage?: string;
  progressPercent?: number;
  currentLot?: number;
  totalLots?: number;
  updatedAt?: string;
  result?: {
    reportId?: string;
    reportType?: string;
    status?: string;
  };
}

type ApiEnvelope<T> = T | { message?: string; data?: T };

function unwrapApiData<T>(value: ApiEnvelope<T>): T {
  const maybeData = (value as any)?.data;
  return (maybeData ?? value) as T;
}

// Get all lot listings for current user
export async function getLotListings(view?: "previews"): Promise<{ data: LotListing[] }> {
  const response = await API.get<{ data: LotListing[]; message?: string }>("/lot-listing", view ? { params: { view }, timeout: 30000 } : undefined);
  // Server returns { message, data }, so extract the data array
  const listings = Array.isArray(response.data) ? response.data : response.data?.data;
  if (!Array.isArray(listings)) throw new Error("Lot Listing returned an incomplete response. Refresh to try again.");
  return { data: listings };
}

// Get lot listing by ID
export async function getLotListingById(id: string): Promise<LotListing> {
  const response = await API.get<ApiEnvelope<LotListing>>(`/lot-listing/${id}`);
  return unwrapApiData(response.data);
}

// Get lot listing progress
export async function getLotListingProgress(id: string): Promise<LotListingProgress> {
  const response = await API.get<LotListingProgress>(`/lot-listing/progress/${id}`);
  return response.data;
}

// Get lot listing preview
export async function getLotListingPreview(id: string): Promise<LotListing> {
  const response = await API.get<ApiEnvelope<LotListing>>(`/lot-listing/${id}/preview`);
  return unwrapApiData(response.data);
}

export async function getLotListingSubmittedPreview(id: string): Promise<LotListing> {
  const response = await API.get<ApiEnvelope<LotListing>>(`/lot-listing/${id}/submitted-preview`);
  return unwrapApiData(response.data);
}

// Update lot listing preview
export async function updateLotListingPreview(
  id: string,
  data: {
    preview_data?: any;
    lots?: LotListingLot[];
    details?: LotListing["details"];
    regenerate_files_on_lot_number_change?: boolean;
  }
): Promise<{
  message: string;
  data: LotListing;
  imageUrls?: string[];
  image_count?: number;
  files_regeneration_queued?: boolean;
}> {
  const response = await API.put<{
    message: string;
    data: LotListing;
    imageUrls?: string[];
    image_count?: number;
    files_regeneration_queued?: boolean;
  }>(
    `/lot-listing/${id}/preview`,
    data
  );
  return response.data;
}

export async function uploadLotListingPreviewLotImages(
  id: string,
  lotKey: string | number,
  files: File[],
  previewData?: any,
  onProgress?: (progress: number) => void
): Promise<{
  message: string;
  data: {
    preview_data: any;
    preview_files?: LotListingPreviewFiles;
    files?: LotListingPreviewFiles;
    imageUrls?: string[];
    image_count?: number;
    added?: Array<{ index: number; url: string; name: string }>;
    duplicatesSkipped?: number;
    lotIndex?: number;
    files_generating?: boolean;
    files_regenerating?: boolean;
  };
  files_regeneration_queued?: boolean;
}> {
  const formData = new FormData();
  files.forEach((file) => formData.append("images", file));
  if (previewData) {
    formData.append("preview_data", JSON.stringify(previewData));
  }

  const response = await API.post(
    `/lot-listing/${id}/preview/lots/${encodeURIComponent(String(lotKey))}/images`,
    formData,
    {
      headers: { "Content-Type": "multipart/form-data" },
      onUploadProgress: (event) => {
        if (!onProgress || !event.total) return;
        onProgress(Math.min(100, Math.round((event.loaded * 100) / event.total)));
      },
    }
  );
  return response.data;
}

export async function refreshLotListingSpecPdf(
  id: string
): Promise<{
  message: string;
  data: {
    spec_pdf: string;
    cr_docx?: string;
    preview_files?: LotListingPreviewFiles;
    files?: LotListingPreviewFiles;
    preview_data?: LotListing["preview_data"];
    imageUrls?: string[];
    image_count?: number;
  };
}> {
  const response = await API.post<{
    message: string;
    data: {
      spec_pdf: string;
      cr_docx?: string;
      preview_files?: LotListingPreviewFiles;
      files?: LotListingPreviewFiles;
      preview_data?: LotListing["preview_data"];
      imageUrls?: string[];
      image_count?: number;
    };
  }>(`/lot-listing/${id}/preview/spec-pdf`, {});
  return response.data;
}

// Submit lot listing for approval
export async function submitLotListingForApproval(
  id: string,
  data?: { preview_data?: any }
): Promise<LotListing> {
  const response = await API.post<ApiEnvelope<LotListing>>(`/lot-listing/${id}/submit-approval`, data || {});
  return unwrapApiData(response.data);
}

// Resubmit lot listing (regenerate files)
export async function resubmitLotListing(id: string, data?: { preview_data?: any }): Promise<LotListing> {
  const response = await API.post<ApiEnvelope<LotListing>>(`/lot-listing/${id}/resubmit`, data || {});
  return unwrapApiData(response.data);
}

// Delete lot listing
export async function deleteLotListing(id: string): Promise<void> {
  await API.delete(`/lot-listing/${id}`);
}

// Get submitted lot listings (pending_approval and approved)
export async function getSubmittedLotListings(): Promise<{ data: LotListing[] }> {
  const response = await API.get<{ data: LotListing[]; message?: string }>("/lot-listing");
  // Server returns { message, data }, so extract the data array
  const listings = Array.isArray(response.data) ? response.data : (response.data?.data || []);
  const submitted = listings.filter(
    (r: any) =>
      r.status === "pending_approval" ||
      r.status === "approved" ||
      Boolean(r.preview_submitted_at) ||
      Boolean(r.approval_requested_at) ||
      r.generation_target_status === "approved" ||
      r.generation_target_status === "pending_approval"
  );
  return { data: submitted };
}

/** Keep the original lot/media order when submitting or resuming the same job. */
export async function createLotListing(
  details: Record<string, unknown>,
  lots: readonly SubmissionLotMedia[],
  options?: { onUploadProgress?: (fraction: number) => void; signal?: AbortSignal }
): Promise<Record<string, unknown>> {
  const authSession = captureAuthSession();
  try {
    return await uploadReportFilesDirectToR2({
      endpoint: "/lot-listing",
      details,
      files: lotListingDirectUploadFiles(lots),
      onUploadProgress: options?.onUploadProgress,
      signal: options?.signal,
      authSession,
    }) as Record<string, unknown>;
  } catch (error) {
    assertAuthSessionCurrent(authSession);
    if (options?.signal?.aborted) throw options.signal.reason || error;
    // Only initial capability failure authorizes the older transport. Business
    // errors and uncertain session outcomes retain the original identity.
    if (!isUploadSessionUnsupportedError(error)) throw error;
  }

  const { images, videos } = submissionFilesFromLots(lots);
  const formData = new FormData();
  images.forEach((file) => formData.append("images", file));
  videos.forEach((file) => formData.append("videos", file));
  formData.append("details", JSON.stringify(details));
  assertAuthSessionCurrent(authSession);
  const { data } = await API.post<Record<string, unknown>>("/lot-listing", formData, {
    signal: options?.signal,
    onUploadProgress: (event: AxiosProgressEvent) => {
      if (!options?.onUploadProgress || options.signal?.aborted || !isAuthSessionCurrent(authSession)) return;
      const fraction = typeof event.progress === "number" ? event.progress :
        typeof event.total === "number" && event.total > 0 ? event.loaded / event.total : 0;
      // Multipart transport progress is not an acceptance receipt.
      options.onUploadProgress(Number.isFinite(fraction) ? Math.max(0, Math.min(0.95, fraction)) : 0);
    },
  });
  assertAuthSessionCurrent(authSession);
  if (options?.signal?.aborted) throw options.signal.reason || new DOMException("The operation was aborted.", "AbortError");
  assertReportUploadAccepted(data);
  options?.onUploadProgress?.(1);
  return data;
}

export const LotListingService = {
  createLotListing,
  getLotListings,
  getLotListingById,
  getLotListingProgress,
  getLotListingPreview,
  getLotListingSubmittedPreview,
  updateLotListingPreview,
  uploadLotListingPreviewLotImages,
  refreshLotListingSpecPdf,
  submitLotListingForApproval,
  resubmitLotListing,
  deleteLotListing,
  getSubmittedLotListings,
};

export default LotListingService;
