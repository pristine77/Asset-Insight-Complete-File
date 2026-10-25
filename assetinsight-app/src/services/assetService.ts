/* eslint-disable @typescript-eslint/no-explicit-any */
import api from "./api";
import { createUploadOperation, cancellableUploadRequest, type UploadOperation } from './uploadCancellation';
import { API_ENDPOINTS } from "../config/api";
import { isRetryableRequestError } from "./connectivityService";
import { restoreImageWatermarkPreference } from "../utils/watermarkPreference";
import {
  uploadReportFilesDirectToR2,
  type DirectUploadFile,
  type DirectUploadProgressCallback,
  type ReportTransferHandoff,
} from "./directR2UploadService";

// Types matching web and server
export type AssetGroupingMode =
  | "single_lot"
  | "per_item"
  | "per_photo"
  | "catalogue"
  | "combined"
  | "mixed";

export type MixedLotMode = "single_lot" | "per_item" | "per_photo";
export type ReportWorkflowStage =
  | 'preparing_preview'
  | 'preview_ready'
  | 'generating_files'
  | 'awaiting_approval'
  | 'awaiting_release'
  | 'ready'
  | 'error';

export interface MixedLot {
  id: string;
  files: Array<{ uri: string; name: string; type: string; size?: number; captureOrder?: number; originalOrder?: number }>;
  extraFiles: Array<{ uri: string; name: string; type: string; size?: number; captureOrder?: number; originalOrder?: number }>;
  videoFile?: { uri: string; name: string; type: string; size?: number };
  coverIndex: number;
  mode?: MixedLotMode;
}

export interface AssetCreateDetails {
  capture_id?: string;
  client_submission_id?: string;
  supersedes_client_submission_id?: string;
  auctioneer_work_item_id?: string;
  force_new?: boolean;
  // Client info
  client_name: string;
  owner_name?: string;
  prepared_for?: string;

  // Appraisal details
  appraisal_purpose: string;
  effective_date: string;
  inspection_date?: string;
  industry?: string;
  contract_no?: string;
  location?: string;
  latitude?: number;
  longitude?: number;

  // Appraiser info
  appraiser: string;
  appraisal_company?: string;

  // Settings
  currency: string;
  language: "en" | "fr" | "es";
  grouping_mode: AssetGroupingMode;

  // Valuation
  include_valuation_table?: boolean;
  valuation_methods?: Array<"FML" | "TKV" | "OLV" | "FLV">;
  include_damage_analysis?: boolean;
  bank_photos_enabled?: boolean;
  watermark_images?: boolean;

  // Factors
  factors_age_condition?: string;
  factors_quality?: string;
  factors_analysis?: string;

  // Mixed lots mapping (for server to know image distribution)
  mixed_lots?: Array<{
    count: number;
    extra_count: number;
    video_count?: number;
    cover_index: number;
    mode: MixedLotMode;
    source_key?: string;
    source_lot_id?: string;
    source_submission_id?: string;
  }>;

  // Image enhancement (server-side: +40% saturation, +40% sharpness, +30% contrast)
  enhance_images?: boolean;

  // Focus box data for AI (red rectangle drawn server-side)
  focus_boxes?: Array<{ imageIndex: number; x: number; y: number; w: number; h: number }>;

  // Progress tracking
  progress_id?: string;
}

export interface AssetReport {
  _id: string;
  status: string;
  grouping_mode: AssetGroupingMode;
  imageUrls?: string[];
  preview_data?: any;
  preview_files?: {
    pdf?: string;
    spec_pdf?: string;
    cr_docx?: string;
    docx?: string;
    excel?: string;
    images?: string;
  };
  release_status?: "pending_release" | "released";
  release_assigned_to?: string | { _id?: string; email?: string; username?: string } | null;
  released_at?: string | null;
  downloadable?: boolean;
  generation_state?: 'queued' | 'processing' | 'ready' | 'error';
  workflow_stage?: ReportWorkflowStage;
  workflow_message?: string;
  workflow_progress_percent?: number;
  files_ready?: boolean;
  files_generating?: boolean;
  files_regenerating?: boolean;
  preview_transferred_from?: string | null;
  preview_transferred_to?: string | null;
  preview_transferred_by?: string | null;
  preview_transferred_at?: string | null;
  job_status?: 'queued' | 'processing' | 'done' | 'error';
  job_error?: string;
  generation_progress?: {
    stage?: string;
    progressPercent?: number;
    message?: string;
    currentLot?: number;
    totalLots?: number;
    updatedAt?: string;
  };
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
  status: string;
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
  status: string;
  resumed: boolean;
  is_merged_report: true;
  sourceCount: number;
  lotCount: number;
  merge_conflicts: AssetMergeConflict[];
  generation_state?: "queued" | "processing" | "ready" | "error";
}

export interface ProgressData {
  id: string;
  phase: string;
  serverProgress01: number;
  steps: Array<{
    key: string;
    label: string;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
  }>;
  message?: string;
}

class AssetService {
  /**
   * Create a new asset report with images
   * @param details Report details
   * @param lots Mixed lots with images
   * @param onUploadProgress Progress callback
   * @param options.operation The caller's upload operation. Pausing it
   *   (pauseUploadOperation) stops this transfer, direct or multipart, and no
   *   other upload.
   */
  async createAssetReport(
    details: AssetCreateDetails,
    lots: MixedLot[],
    onUploadProgress?: DirectUploadProgressCallback,
    options?: { operation?: UploadOperation; handoff?: ReportTransferHandoff }
  ): Promise<{ jobId: string; message: string; reportId?: string; backgroundStaged?: boolean }> {
    const operation = createUploadOperation(options?.operation);
    // Send an explicit choice even to older APIs whose missing-field default
    // was true. Never mutate the saved draft supplied by the caller.
    const uploadDetails = {
      ...details,
      watermark_images: restoreImageWatermarkPreference(details.watermark_images),
      ...(details.mixed_lots ? {
        // Multipart has one ordered video array: explicit zeros prevent a clip
        // from a later lot being attached to the first lot without a video.
        mixed_lots: details.mixed_lots.map((lot, index) => ({
          ...lot,
          video_count: lots[index]?.videoFile ? 1 : 0,
        })),
      } : {}),
    };
    try {
      const files: DirectUploadFile[] = [];
      lots.forEach((lot, lotIndex) => {
        lot.files.forEach((file, imageIndex) => {
          files.push({
            uri: file.uri,
            name: file.name || `lot-${lotIndex + 1}-main-${imageIndex + 1}.jpg`,
            type: file.type || "image/jpeg",
            size: file.size,
            fieldname: "images",
            lotIndex,
            imageIndex,
            captureOrder: file.captureOrder ?? imageIndex,
            originalOrder: file.originalOrder ?? file.captureOrder ?? imageIndex,
            role: "main",
          });
        });
        lot.extraFiles.forEach((file, imageIndex) => {
          files.push({
            uri: file.uri,
            name: file.name || `lot-${lotIndex + 1}-extra-${imageIndex + 1}.jpg`,
            type: file.type || "image/jpeg",
            size: file.size,
            fieldname: "images",
            lotIndex,
            imageIndex,
            captureOrder: file.captureOrder ?? imageIndex,
            originalOrder: file.originalOrder ?? file.captureOrder ?? imageIndex,
            role: "extra",
          });
        });
        if (lot.videoFile) {
          files.push({
            uri: lot.videoFile.uri,
            name: lot.videoFile.name || `lot-${lotIndex + 1}-walkthrough.mp4`,
            type: lot.videoFile.type || "video/mp4",
            size: lot.videoFile.size,
            fieldname: "videos",
            lotIndex,
            imageIndex: 0,
            role: "video",
          });
        }
      });

      const response = await uploadReportFilesDirectToR2({
        endpoint: "/asset",
        details: uploadDetails,
        files,
        onProgress: onUploadProgress,
        operation,
        handoff: options?.handoff,
      });
      operation.assertActive();
      return response;
    } catch (error: any) {
      operation.assertActive();
      const status = Number(error?.response?.status || 0);
      if (options?.handoff || ![404, 405, 501].includes(status)) throw error;
      console.warn("[AssetService] Direct upload is unsupported; using legacy multipart upload.");
    }

    const formData = new FormData();

    // Add details as JSON
    formData.append("details", JSON.stringify(uploadDetails));

    // Add images from lots
    let imageIndex = 0;
    for (const lot of lots) {
      // Add main files
      for (const file of lot.files) {
        const fileObj = {
          uri: file.uri,
          name: file.name || `image-${imageIndex}.jpg`,
          type: file.type || "image/jpeg",
        } as any;
        formData.append("images", fileObj);
        imageIndex++;
      }

      // Add extra files
      for (const file of lot.extraFiles) {
        const fileObj = {
          uri: file.uri,
          name: file.name || `extra-${imageIndex}.jpg`,
          type: file.type || "image/jpeg",
        } as any;
        formData.append("images", fileObj);
        imageIndex++;
      }

      // Add video if present
      if (lot.videoFile) {
        const videoObj = {
          uri: lot.videoFile.uri,
          name: lot.videoFile.name || `video-${lot.id}.mp4`,
          type: lot.videoFile.type || "video/mp4",
        } as any;
        formData.append("videos", videoObj);
      }
    }

    operation.assertActive();
    const response = await cancellableUploadRequest(operation, (signal) => api.post(API_ENDPOINTS.CREATE_ASSET, formData, {
      signal,
      headers: {
        "Content-Type": "multipart/form-data",
      },
      timeout: 300000, // 5 minutes for large uploads
      onUploadProgress: (progressEvent: any) => {
        if (!operation.isActive()) return;
        if (onUploadProgress && progressEvent.total) {
          const progress = Math.min(100, Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          ));
          onUploadProgress(progress);
        }
      },
    }));

    return response.data;
  }

  /**
   * Get all asset reports for current user
   */
  async getAssetReports(view?: 'previews'): Promise<AssetReport[]> {
    const response = await api.get(API_ENDPOINTS.GET_ASSETS, view ? { params: { view } } : undefined);
    if (!Array.isArray(response.data?.data)) throw new Error('Asset reports returned an incomplete response. Refresh to try again.');
    return response.data.data;
  }

  /**
   * Get progress for a specific job
   */
  async getProgress(jobId: string): Promise<ProgressData | null> {
    try {
      const response = await api.get(`${API_ENDPOINTS.GET_ASSET_PROGRESS}/${jobId}`);
      return response.data;
    } catch (e: any) {
      if (e.response?.status === 404) return null;
      throw e;
    }
  }

  /**
   * Get preview data for editing
   */
  async getPreviewData(reportId: string): Promise<any> {
    const response = await api.get(`${API_ENDPOINTS.GET_PREVIEW}/${reportId}/preview`);
    return response.data.data;
  }

  /**
   * Update preview data with edits
   */
  async updatePreviewData(reportId: string, previewData: any): Promise<void> {
    await api.put(`${API_ENDPOINTS.UPDATE_PREVIEW}/${reportId}/preview`, {
      preview_data: previewData,
    });
  }

  async getMergeCandidates(reportId: string): Promise<AssetMergeCandidatesResponse> {
    const response = await api.get(`/asset/${reportId}/merge-candidates`);
    return response.data.data;
  }

  async mergeReports(payload: {
    sourceReportIds: string[];
    primaryReportId: string;
    mergeRequestId: string;
  }): Promise<AssetMergeResult> {
    const response = await api.post("/asset/merge", payload);
    return response.data.data;
  }

  async uploadPreviewLotImages(
    reportId: string,
    lotKey: string | number,
    images: Array<{ uri: string; name?: string | null; type?: string | null }>,
    previewData?: any,
    onUploadProgress?: (progress: number) => void
  ): Promise<any> {
    const formData = new FormData();
    images.forEach((image, index) => {
      const uriName = image.uri.split(/[\\/]/).pop() || `preview-image-${index + 1}.jpg`;
      formData.append("images", {
        uri: image.uri,
        name: image.name || uriName,
        type: image.type || "image/jpeg",
      } as any);
    });
    if (previewData) {
      formData.append("preview_data", JSON.stringify(previewData));
    }

    const response = await api.post(
      `${API_ENDPOINTS.UPDATE_PREVIEW}/${reportId}/preview/lots/${encodeURIComponent(String(lotKey))}/images`,
      formData,
      {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 300000,
        onUploadProgress: (progressEvent: any) => {
          if (onUploadProgress && progressEvent.total) {
            onUploadProgress(Math.min(100, Math.round((progressEvent.loaded * 100) / progressEvent.total)));
          }
        },
      }
    );
    return response.data;
  }

  /**
   * Submit preview for approval
   */
  async submitPreview(reportId: string, previewData?: any): Promise<any> {
    const response = await api.post(
      `${API_ENDPOINTS.SUBMIT_PREVIEW}/${reportId}/submit-approval`,
      previewData ? { preview_data: previewData } : {}
    );
    return response.data?.data || response.data;
  }

  /**
   * Poll progress until complete
   */
  async pollProgress(
    jobId: string,
    onProgress: (data: ProgressData) => void,
    intervalMs: number = 2000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let transientFailures = 0;
      const maxTransientFailures = 20;
      const poll = async () => {
        try {
          const data = await this.getProgress(jobId);
          if (!data) {
            transientFailures += 1;
            if (transientFailures > maxTransientFailures) {
              reject(new Error("Preview processing is continuing, but its progress is temporarily unavailable."));
              return;
            }
            setTimeout(poll, Math.min(15000, intervalMs * 2 ** Math.min(transientFailures, 3)));
            return;
          }

          transientFailures = 0;
          onProgress(data);

          if (data.phase === "done" || data.phase === "error") {
            resolve();
            return;
          }

          setTimeout(poll, intervalMs);
        } catch (e) {
          if (isRetryableRequestError(e) && transientFailures < maxTransientFailures) {
            transientFailures += 1;
            setTimeout(poll, Math.min(15000, intervalMs * 2 ** Math.min(transientFailures, 3)));
            return;
          }
          reject(e);
        }
      };

      poll();
    });
  }
}

export const assetService = new AssetService();
export default assetService;
