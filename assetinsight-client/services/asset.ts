import API from "@/lib/api";
import { assertAuthSessionCurrent, captureAuthSession, isAuthSessionCurrent } from "@/lib/auth-storage";
import type { AxiosProgressEvent } from "axios";
import { assertReportUploadAccepted } from "./reportTransferErrors";
import {
  isUploadSessionUnsupportedError,
  uploadReportFilesDirectToR2,
  type DirectUploadFile,
} from "./directUpload";

export type AssetGroupingMode =
  | "single_lot"
  | "per_item"
  | "per_photo"
  | "catalogue"
  | "combined"
  | "mixed";

export type AssetCreateDetails = {
  grouping_mode: AssetGroupingMode;
  // Optional metadata fields
  client_name?: string;
  effective_date?: string; // ISO date string (YYYY-MM-DD)
  appraisal_purpose?: string;
  owner_name?: string;
  appraiser?: string;
  appraisal_company?: string;
  industry?: string;
  inspection_date?: string; // ISO date string (YYYY-MM-DD)
  location?: string;
  latitude?: number;
  longitude?: number;
  // New optional fields
  contract_no?: string; // user-provided contract number
  language?: 'en' | 'fr' | 'es'; // report output language for DOCX (default 'en')
  currency?: string; // ISO currency code (e.g., CAD, USD)
  // Valuation comparison table
  include_valuation_table?: boolean;
  valuation_methods?: Array<'FML' | 'TKV' | 'OLV' | 'FLV'>;
  include_damage_analysis?: boolean;
  bank_photos_enabled?: boolean;
  watermark_images?: boolean;
  activity_id?: string;
  // Cover page + Factors
  prepared_for?: string; // used in templated cover
  factors_age_condition?: string; // populates Age & Condition under Factors Affecting Value
  factors_quality?: string; // populates Quality under Factors Affecting Value
  factors_analysis?: string; // populates Analysis under Factors Affecting Value
  // Real-time progress
  progress_id?: string;
  auctioneer_work_item_id?: string;
  // Catalogue mode: describe how files map to lots (flattened in order)
  catalogue_lots?: Array<{
    count: number; // number of images in this lot (max 20)
    cover_index?: number; // 0-based index within this lot to use as cover (defaults to 0)
  }>;
  // Combined mode: which sections to include in the single DOCX report
  combined_modes?: Array<"single_lot" | "per_item" | "per_photo">;
  // Mixed mode: describe each lot's mode and image counts (flattened in order)
  mixed_lots?: Array<{
    count: number; // number of main images in this lot
    extra_count?: number; // report-only images in this lot
    video_count?: number; // ordered clips in this lot, including explicit zeros
    cover_index?: number; // 0-based within the lot
    mode: "single_lot" | "per_item" | "per_photo";
    source_key?: string;
    source_lot_id?: string;
    source_submission_id?: string;
  }>;
  focus_boxes?: Array<{
    imageIndex: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }>;
};

export type AssetCreateResponse = {
  message: string;
  // Background job ack fields (202 Accepted)
  jobId?: string;
  reportId?: string;
  status?: "processing" | "preview" | "error";
  phase?: "upload" | "processing" | "done" | "error";
  // Legacy immediate response fields (if any)
  filePath?: string;
  data?: any;
};

export type CreateOptions = {
  onUploadProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

export type AssetProgress = {
  id: string;
  phase: "upload" | "processing" | "done" | "error";
  serverProgress01: number; // 0..1 for server-side portion
  steps: Array<{
    key: string;
    label: string;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
  }>;
  message?: string;
  result?: {
    reportId?: string;
    reportType?: string;
    status?: string;
  };
};

export const AssetService = {
  async create(
    details: AssetCreateDetails,
    images: File[],
    videos?: File[] | undefined,
    options?: CreateOptions
  ): Promise<AssetCreateResponse> {
    const authSession = captureAuthSession();
    // Transport every selected image. Any AI inspection cap is a server-side
    // analysis concern and must not silently drop photos from the report.
    const filesToSend = images;
    const videoFiles = Array.isArray(videos) ? videos : [];
    const videoLotIndexes: number[] = [];
    if (details.grouping_mode === "mixed" && details.mixed_lots?.some((lot) => lot.video_count !== undefined)) {
      for (const [lotIndex, lot] of details.mixed_lots.entries()) {
        const count = lot.video_count;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > videoFiles.length - videoLotIndexes.length) {
          throw new Error("Video counts do not match the selected lot videos. Review the videos before retrying.");
        }
        for (let index = 0; index < count; index += 1) videoLotIndexes.push(lotIndex);
      }
      if (videoLotIndexes.length !== videoFiles.length) {
        throw new Error("Video counts do not match the selected lot videos. Review the videos before retrying.");
      }
    }

    try {
      const directFiles: DirectUploadFile[] = [
        ...filesToSend.map((file, imageIndex) => ({
          file,
          fieldname: "images" as const,
          imageIndex,
          role: "main" as const,
        })),
        ...videoFiles.map((file, imageIndex) => ({
          file,
          fieldname: "videos" as const,
          imageIndex,
          ...(videoLotIndexes[imageIndex] !== undefined ? { lotIndex: videoLotIndexes[imageIndex] } : {}),
          role: "video" as const,
        })),
      ];
      return await uploadReportFilesDirectToR2({
        endpoint: "/asset",
        details,
        files: directFiles,
        onUploadProgress: options?.onUploadProgress,
        signal: options?.signal,
        authSession,
      });
    } catch (error: any) {
      assertAuthSessionCurrent(authSession);
      if (options?.signal?.aborted) throw options.signal.reason || error;
      if (!isUploadSessionUnsupportedError(error)) throw error;
      console.warn("[AssetService] Direct upload is unsupported; using legacy multipart upload.");
    }

    const fd = new FormData();
    fd.append("details", JSON.stringify(details));
    filesToSend.forEach((file) => fd.append("images", file));
    // Append videos (if any) under a separate field; backend will include them in the zip, not AI
    videoFiles.forEach((file) => fd.append("videos", file));

    assertAuthSessionCurrent(authSession);
    const { data } = await API.post<AssetCreateResponse>("/asset", fd, {
      onUploadProgress: (e: AxiosProgressEvent) => {
        if (!options?.onUploadProgress || options.signal?.aborted || !isAuthSessionCurrent(authSession)) return;
        let fraction = typeof e.progress === "number" ? e.progress : 0;
        if (
          !fraction &&
          typeof e.loaded === "number" &&
          typeof e.total === "number" &&
          e.total > 0
        ) {
          fraction = e.loaded / e.total;
        }
        // Sending all request bytes is not server acceptance. Keep the same
        // completion boundary as session uploads, including on older servers.
        options.onUploadProgress(Number.isFinite(fraction) ? Math.max(0, Math.min(0.95, fraction)) : 0);
      },
      signal: options?.signal,
    });
    assertAuthSessionCurrent(authSession);
    if (options?.signal?.aborted) throw options.signal.reason || new DOMException("The operation was aborted.", "AbortError");
    assertReportUploadAccepted(data);
    options?.onUploadProgress?.(1);
    return data;
  },

  async listMyReports() {
    const { data } = await API.get("/asset");
    return data;
  },

  async progress(id: string): Promise<AssetProgress> {
    const { data } = await API.get(`/asset/progress/${id}`);
    return data as AssetProgress;
  },
};
