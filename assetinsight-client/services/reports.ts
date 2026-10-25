import API from "@/lib/api";
import type { SubmittedPreviewDataResponse } from "@/services/assets";

export type ReportStats = {
  totalReports: number;
  totalFairMarketValue: number;
  breakdown?: {
    counts: Record<string, number>;
    values: Record<string, number>;
  };
};

export type PdfReport = {
  _id: string;
  filename: string;
  address: string;
  fairMarketValue: string;
  createdAt: string; // ISO string
  report?: string; // underlying report id for grouping
  type?: string;
  fileType?: 'pdf' | 'spec_pdf' | 'cr_docx' | 'docx' | 'xlsx' | 'images';
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  approvalNote?: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  contract_no?: string;
  thumbnail_url?: string | null;
  thumbnailUrl?: string | null;
  url?: string;
  crReportId?: string;
  valuationMethods?: Array<{ method: string; value: number }>;
  release_status?: "pending_release" | "released";
  release_assigned_to?: string | { _id?: string; email?: string; username?: string } | null;
  released_at?: string | null;
  downloadable?: boolean;
};

export type AssignedApproval = PdfReport & {
  reportType: "Asset" | "RealEstate" | "LotListing" | "Salvage";
  user?: { _id?: string; email?: string; username?: string };
  isAssetReport?: boolean;
  isRealEstateReport?: boolean;
  isLotListing?: boolean;
  preview_files?: Record<string, string>;
  files?: Record<string, string>;
  auctioneer_work_item_id?: string;
};

export type AssignedRelease = PdfReport & {
  reportType: "Asset" | "RealEstate" | "LotListing" | "Salvage";
  user?: { _id?: string; email?: string; username?: string };
  isAssetReport?: boolean;
  isRealEstateReport?: boolean;
  isLotListing?: boolean;
  preview_files?: Record<string, string>;
  files?: Record<string, string>;
};

export const ReportsService = {
  async getReportStats(): Promise<ReportStats> {
    const { data } = await API.get<ReportStats>("/reports/stats");
    return data;
  },

  async getMyReports(): Promise<PdfReport[]> {
    const { data } = await API.get<PdfReport[]>("/reports/myreports");
    return data;
  },

  async downloadReport(id: string): Promise<{ blob: Blob; filename?: string }> {
    const response = await API.get<Blob>(`/reports/${id}/download`, {
      responseType: "blob" as const,
    });
    const disposition = (response.headers as any)["content-disposition"] as
      | string
      | undefined;
    let filename: string | undefined;
    if (disposition) {
      const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
      if (match && match[1]) {
        filename = match[1].replace(/['"]/g, "").trim();
      }
    }
    return { blob: response.data, filename };
  },

  async downloadCr(reportId: string): Promise<{ blob: Blob; filename?: string }> {
    const response = await API.get<Blob>(`/reports/${reportId}/cr/download`, {
      responseType: "blob" as const,
    });
    const disposition = (response.headers as any)["content-disposition"] as
      | string
      | undefined;
    let filename: string | undefined;
    if (disposition) {
      const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
      if (match && match[1]) {
        filename = match[1].replace(/['"]/g, "").trim();
      }
    }
    return { blob: response.data, filename };
  },

  async downloadCrDocx(reportId: string): Promise<{ blob: Blob; filename?: string }> {
    const response = await API.get<Blob>(`/reports/${reportId}/cr-docx`, {
      responseType: "blob" as const,
    });
    const disposition = (response.headers as any)["content-disposition"] as
      | string
      | undefined;
    let filename: string | undefined;
    if (disposition) {
      const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
      if (match && match[1]) {
        filename = match[1].replace(/['"]/g, "").trim();
      }
    }
    return { blob: response.data, filename };
  },

  async deleteReport(id: string): Promise<{ message: string }> {
    const { data } = await API.delete<{ message: string }>(`/reports/${id}`);
    return data;
  },

  async getAssignedApprovals(): Promise<{ items: AssignedApproval[]; total: number }> {
    const { data } = await API.get<{ items: AssignedApproval[]; total: number }>(
      "/reports/assigned-approvals"
    );
    return data;
  },

  async approveAssignedApproval(id: string): Promise<{ message: string }> {
    const { data } = await API.post<{ message: string }>(
      `/reports/assigned-approvals/${id}/approve`
    );
    return data;
  },

  async rejectAssignedApproval(id: string, note: string): Promise<{ message: string }> {
    const { data } = await API.post<{ message: string }>(
      `/reports/assigned-approvals/${id}/reject`,
      { note }
    );
    return data;
  },

  async getAssignedAssetPreview(id: string): Promise<SubmittedPreviewDataResponse> {
    const { data } = await API.get<SubmittedPreviewDataResponse>(
      `/reports/assigned-approvals/${id}/preview`
    );
    return data;
  },

  async getAssignedPreview(id: string): Promise<SubmittedPreviewDataResponse> {
    const { data } = await API.get<SubmittedPreviewDataResponse>(
      `/reports/assigned-approvals/${id}/preview`
    );
    return data;
  },

  async updateAssignedAssetPreview(
    id: string,
    previewData: any
  ): Promise<{ message: string; data: any; imageUrls?: string[]; image_count?: number; files_regeneration_queued?: boolean }> {
    const { data } = await API.put<{ message: string; data: any; imageUrls?: string[]; image_count?: number; files_regeneration_queued?: boolean }>(
      `/reports/assigned-approvals/${id}/preview`,
      { preview_data: previewData }
    );
    return data;
  },

  async updateAssignedPreview(
    id: string,
    previewData: any
  ): Promise<{ message: string; data: any; imageUrls?: string[]; image_count?: number; files_regeneration_queued?: boolean }> {
    const { data } = await API.put<{ message: string; data: any; imageUrls?: string[]; image_count?: number; files_regeneration_queued?: boolean }>(
      `/reports/assigned-approvals/${id}/preview`,
      { preview_data: previewData }
    );
    return data;
  },

  async resubmitAssignedAssetPreview(
    id: string,
    previewData?: any
  ): Promise<{ message: string; data: any }> {
    const { data } = await API.post<{ message: string; data: any }>(
      `/reports/assigned-approvals/${id}/preview/resubmit`,
      previewData ? { preview_data: previewData } : {}
    );
    return data;
  },

  async resubmitAssignedPreview(
    id: string,
    previewData?: any
  ): Promise<{ message: string; data: any }> {
    const { data } = await API.post<{ message: string; data: any }>(
      `/reports/assigned-approvals/${id}/preview/resubmit`,
      previewData ? { preview_data: previewData } : {}
    );
    return data;
  },

  async uploadAssignedPreviewLotImages(
    id: string,
    lotKey: string | number,
    files: File[],
    previewData?: any,
    onProgress?: (progress: number) => void
  ): Promise<{
    message: string;
    data: {
      preview_data: any;
      preview_files?: Record<string, string>;
      imageUrls?: string[];
      image_count?: number;
      added?: Array<{ index: number; url: string; name: string }>;
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

    const { data } = await API.post(
      `/reports/assigned-approvals/${id}/preview/lots/${encodeURIComponent(String(lotKey))}/images`,
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
  },

  async refreshAssignedPreviewSpecPdf(id: string): Promise<{
    message: string;
    data: {
      spec_pdf: string;
      cr_docx?: string;
      preview_files?: Record<string, string>;
      preview_data?: any;
      imageUrls?: string[];
      image_count?: number;
    };
  }> {
    const { data } = await API.post<{
      message: string;
      data: {
        spec_pdf: string;
        cr_docx?: string;
        preview_files?: Record<string, string>;
        preview_data?: any;
        imageUrls?: string[];
        image_count?: number;
      };
    }>(`/reports/assigned-approvals/${id}/preview/spec-pdf`, {});
    return data;
  },

  async getAssignedReleases(): Promise<{ items: AssignedRelease[]; total: number }> {
    const { data } = await API.get<{ items: AssignedRelease[]; total: number }>(
      "/reports/assigned-releases"
    );
    return data;
  },

  async releaseAssignedReport(id: string): Promise<{ message: string }> {
    const { data } = await API.post<{ message: string }>(
      `/reports/assigned-releases/${id}/release`
    );
    return data;
  },
};
