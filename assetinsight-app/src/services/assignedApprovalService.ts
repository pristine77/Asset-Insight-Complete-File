import api from "./api";

export type AssignedApproval = {
  _id: string;
  filename?: string;
  address?: string;
  fairMarketValue?: string;
  createdAt?: string;
  updatedAt?: string;
  reportType: "Asset" | "RealEstate" | "Salvage";
  user?: { _id?: string; email?: string; username?: string };
  contract_no?: string;
  isAssetReport?: boolean;
  isRealEstateReport?: boolean;
  preview_files?: Record<string, string>;
};

export type AssignedApprovalsResponse = {
  items: AssignedApproval[];
  total: number;
};

const assignedApprovalService = {
  async getAssignedApprovals(): Promise<AssignedApprovalsResponse> {
    const { data } = await api.get("/reports/assigned-approvals");
    return data;
  },

  async approve(id: string): Promise<{ message: string }> {
    const { data } = await api.post(`/reports/assigned-approvals/${id}/approve`);
    return data;
  },

  async reject(id: string, note: string): Promise<{ message: string }> {
    const { data } = await api.post(`/reports/assigned-approvals/${id}/reject`, { note });
    return data;
  },

  async getPreview(id: string): Promise<any> {
    const { data } = await api.get(`/reports/assigned-approvals/${id}/preview`);
    return data.data;
  },

  async updatePreview(id: string, previewData: any): Promise<any> {
    const { data } = await api.put(`/reports/assigned-approvals/${id}/preview`, {
      preview_data: previewData,
    });
    return data;
  },

  async resubmit(id: string, previewData?: any): Promise<any> {
    const { data } = await api.post(
      `/reports/assigned-approvals/${id}/preview/resubmit`,
      previewData ? { preview_data: previewData } : {}
    );
    return data;
  },

  async uploadPreviewLotImages(
    reportId: string,
    lotKey: string | number,
    images: Array<{ uri: string; name?: string | null; type?: string | null }>,
    previewData?: any,
    onUploadProgress?: (progress: number) => void
  ): Promise<any> {
    const formData = new FormData();
    images.forEach((image, index) => {
      const uriName = image.uri.split(/[\\/]/).pop() || `assigned-preview-image-${index + 1}.jpg`;
      formData.append("images", {
        uri: image.uri,
        name: image.name || uriName,
        type: image.type || "image/jpeg",
      } as any);
    });
    if (previewData) {
      formData.append("preview_data", JSON.stringify(previewData));
    }

    const { data } = await api.post(
      `/reports/assigned-approvals/${reportId}/preview/lots/${encodeURIComponent(String(lotKey))}/images`,
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
    return data;
  },
};

export default assignedApprovalService;
