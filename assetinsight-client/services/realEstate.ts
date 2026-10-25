import API from "@/lib/api";
import type { AxiosProgressEvent } from "axios";

export const REAL_ESTATE_MEDIA_LIMITS = { images: 50, extraImages: 100, videos: 20 } as const;

export type RealEstateDetails = {
  progress_id?: string;
  progressId?: string;
  job_id?: string;
  language?: "en" | "fr" | "es";
  property_type?: "agricultural" | "commercial" | "residential";
  property_details: {
    owner_name: string;
    address: string;
    land_description: string;
    municipality: string;
    title_number: string;
    parcel_number: string;
    land_area_acres: string;
    source_quarter_section: string;
    property_type?: string; // Duplicate for backend compatibility
  };
  report_dates: {
    report_date: string; // ISO date string
    effective_date: string; // ISO date string
    inspection_date: string; // ISO date string
  };
  house_details: {
    year_built: string;
    square_footage: string;
    lot_size_sqft: string;
    number_of_rooms: string;
    number_of_full_bathrooms: string;
    number_of_half_bathrooms: string;
    known_issues: string[];
  };
  // Farmland-specific details (for agricultural properties)
  farmland_details?: {
    total_title_acres?: number;
    cultivated_acres?: number;
    rm_area?: string; // Rural Municipality
    soil_class?: string;
    crop_type?: string;
    is_rented?: boolean;
    annual_rent_per_acre?: number;
    irrigation?: boolean;
    access_quality?: "excellent" | "good" | "fair" | "poor";
    distance_to_city_km?: number;
    // Direct Comparable Approach fields
    use_direct_comparable?: boolean;
    subject_name?: string;
    valuation_date?: string; // ISO date
    notes?: string;
    // Income Capitalization Approach fields
    use_income_approach?: boolean;
    market_rent_per_acre?: number;
    vacancy_loss_percent?: number;
    operating_expense_ratio?: number;
    cap_rate?: number;
    // Cost Approach (AI-calculated)
    use_cost_approach?: boolean;
  };
  inspector_info: {
    inspector_name: string;
    company_name: string;
    contact_email: string;
    contact_phone: string;
    credentials: string;
  };
};

export type RealEstateCreateResponse = {
  message: string;
  // Background job ack fields (202 Accepted)
  jobId?: string;
  phase?: "upload" | "processing" | "done" | "error";
  // Legacy immediate response fields (sync path)
  filePath?: string;
  docxPath?: string;
  xlsxPath?: string;
};

export type RealEstateProgress = {
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
};

export type RealEstateCreateOptions = {
  onUploadProgress?: (fraction: number) => void;
};

export type ReportStatus = 'draft' | 'preview' | 'pending_approval' | 'approved' | 'declined';

export interface RealEstateReport {
  _id: string;
  user: string;
  property_type: string;
  language: string;
  imageUrls: string[];
  extraImageUrls?: string[];
  status: ReportStatus;
  preview_data?: any;
  preview_files?: {
    docx?: string;
    excel?: string;
    images?: string;
  };
  preview_submitted_at?: string;
  approval_requested_at?: string;
  approval_processed_at?: string;
  decline_reason?: string;
  release_status?: "pending_release" | "released";
  release_assigned_to?: string | { _id?: string; email?: string; username?: string } | null;
  released_at?: string | null;
  downloadable?: boolean;
  property_details?: any;
  report_dates?: any;
  valuation?: any;
  farmland_valuation?: any;
  createdAt: string;
  updatedAt: string;
}

export interface RealEstatePreviewDataResponse {
  message: string;
  data: {
    status: ReportStatus;
    preview_data: any;
    property_type?: string;
    language?: string;
    image_count?: number;
    imageUrls?: string[];
    extraImageUrls?: string[];
    decline_reason?: string;
    release_status?: "pending_release" | "released";
    release_assigned_to?: string | { _id?: string; email?: string; username?: string } | null;
    released_at?: string | null;
    downloadable?: boolean;
    files_generating?: boolean;
    files_regenerating?: boolean;
    reportId: string;
  };
}

export const RealEstateService = {
  async create(
    details: RealEstateDetails,
    images: File[], // Main images for AI analysis
    extraImages: File[] = [], // Extra images (report only)
    videos: File[] = [], // Videos (zip only)
    options?: RealEstateCreateOptions
  ): Promise<RealEstateCreateResponse> {
    if (images.length > REAL_ESTATE_MEDIA_LIMITS.images) {
      throw new Error("Real Estate reports support up to 50 main photos.");
    }
    if (extraImages.length > REAL_ESTATE_MEDIA_LIMITS.extraImages) {
      throw new Error("Real Estate reports support up to 100 report-only photos, including the map.");
    }
    if (videos.length > REAL_ESTATE_MEDIA_LIMITS.videos) {
      throw new Error("Real Estate reports support up to 20 videos.");
    }
    const fd = new FormData();
    fd.append("details", JSON.stringify(details));
    // Main images (sent to AI, max 50; backend watermark policy defaults off).
    images.forEach((file) => fd.append("images", file));
    // Extra images (report only; backend watermark policy defaults off).
    extraImages.forEach((file) => fd.append("extraImages", file));
    // Videos (included in zip only)
    videos.forEach((file) => fd.append("videos", file));

    const { data } = await API.post<RealEstateCreateResponse>("/real-estate", fd, {
      onUploadProgress: (event: AxiosProgressEvent) => {
        if (!options?.onUploadProgress) return;
        let fraction = typeof event.progress === "number" ? event.progress : 0;
        if (
          !fraction &&
          typeof event.loaded === "number" &&
          typeof event.total === "number" &&
          event.total > 0
        ) {
          fraction = event.loaded / event.total;
        }
        options.onUploadProgress(Math.max(0, Math.min(1, fraction)));
      },
    });
    return data;
  },

  async progress(id: string): Promise<RealEstateProgress> {
    const { data } = await API.get(`/real-estate/progress/${id}`);
    return data as RealEstateProgress;
  },

  /** Get all real estate reports for current user */
  async getReports(view?: "previews"): Promise<{ data: RealEstateReport[] }> {
    const { data } = await API.get<{ data: RealEstateReport[] }>("/real-estate", view ? { params: { view }, timeout: 30000 } : undefined);
    return data;
  },

  /** Get preview data for editing */
  async getPreviewData(reportId: string): Promise<RealEstatePreviewDataResponse> {
    const { data } = await API.get<RealEstatePreviewDataResponse>(`/real-estate/preview/${reportId}`);
    return data;
  },

  /** Update preview data with user edits */
  async updatePreviewData(reportId: string, previewData: any): Promise<{ message: string; data: any }> {
    const { data } = await API.put<{ message: string; data: any }>(
      `/real-estate/preview/${reportId}`,
      { preview_data: previewData }
    );
    return data;
  },

  /** Submit report for admin approval */
  async submitForApproval(reportId: string): Promise<{ message: string; data: any }> {
    const { data } = await API.post<{ message: string; data: any }>(
      `/real-estate/preview/${reportId}/submit`,
      {}
    );
    return data;
  },

  async resubmitReport(reportId: string, previewData?: any): Promise<{ message: string; data: any }> {
    const { data } = await API.post<{ message: string; data: any }>(
      `/real-estate/${reportId}/resubmit`,
      previewData ? { preview_data: previewData } : {}
    );
    return data;
  },

  /** Delete a real estate report */
  async deleteReport(reportId: string): Promise<{ message: string; data: { reportId: string } }> {
    const { data } = await API.delete<{ message: string; data: { reportId: string } }>(
      `/real-estate/${reportId}`
    );
    return data;
  },
};
