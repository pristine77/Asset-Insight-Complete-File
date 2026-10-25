import api from "./api";

export type AssignedRelease = {
  _id: string;
  filename?: string;
  address?: string;
  fairMarketValue?: string;
  createdAt?: string;
  updatedAt?: string;
  reportType: "Asset" | "RealEstate" | "LotListing" | "Salvage";
  user?: { _id?: string; email?: string; username?: string };
  contract_no?: string;
  release_status?: "pending_release" | "released";
  isAssetReport?: boolean;
  isRealEstateReport?: boolean;
  isLotListing?: boolean;
  preview_files?: Record<string, string>;
  files?: Record<string, string>;
};

export type AssignedReleasesResponse = {
  items: AssignedRelease[];
  total?: number;
};

const assignedReleaseService = {
  async getAssignedReleases(): Promise<AssignedReleasesResponse> {
    const { data } = await api.get("/reports/assigned-releases");
    return data;
  },

  async release(id: string): Promise<{ message: string }> {
    const { data } = await api.post(`/reports/assigned-releases/${id}/release`);
    return data;
  },
};

export default assignedReleaseService;
