import API, { type RetriableAxiosConfig } from "@/lib/api";
import type { AuthUser } from "./auth";

export type UpdateUserPayload = {
  username?: string;
  companyName?: string;
  contactEmail?: string;
  contactPhone?: string;
  companyAddress?: string;
  crmAddress?: string;
};

export const UserService = {
  async getMe(options?: { signal?: AbortSignal; timeout?: number }): Promise<AuthUser> {
    const { data } = await API.get<AuthUser>("/user/me", options);
    return data;
  },

  async update(payload: UpdateUserPayload): Promise<AuthUser> {
    const { data } = await API.put<AuthUser>("/user", payload);
    return data;
  },

  async deleteAccount(password?: string): Promise<{ message: string }> {
    // A wrong password also returns 401. Never refresh and replay a deletion.
    const { data } = await API.delete<{ message: string }>("/user", {
      data: password === undefined ? undefined : { password },
      _retry: true,
      timeout: 30_000,
    } as RetriableAxiosConfig);
    if (data?.message !== "User account deleted successfully") {
      throw new Error("Account deletion was not confirmed. Contact support before trying again.");
    }
    return data;
  },

  async uploadCv(file: File): Promise<AuthUser> {
    const fd = new FormData();
    fd.append("cv", file);
    const { data } = await API.post<AuthUser>("/user/cv", fd);
    return data;
  },

  async deleteCv(): Promise<AuthUser> {
    const { data } = await API.delete<AuthUser>("/user/cv");
    return data;
  },

  async uploadAvatar(file: File): Promise<AuthUser> {
    const body = new FormData();
    body.append("avatar", file);
    const { data } = await API.post<AuthUser>("/user/avatar", body);
    return data;
  },

  async deleteAvatar(): Promise<AuthUser> {
    const { data } = await API.delete<AuthUser>("/user/avatar");
    return data;
  },

  /*
    Appraiser profile printed on Salvage appraisal reports (owner, 2026-11-01:
    "Profile, set once"): designation and title, a signature image and a CV PDF.
  */
  async updateAppraiserProfile(payload: { designation?: string; title?: string }): Promise<AuthUser> {
    const { data } = await API.patch<AuthUser>("/user/appraiser-profile", payload);
    return data;
  },

  async uploadAppraiserSignature(file: File): Promise<AuthUser> {
    const body = new FormData();
    body.append("signature", file);
    const { data } = await API.post<AuthUser>("/user/appraiser-profile/signature", body);
    return data;
  },

  async deleteAppraiserSignature(): Promise<AuthUser> {
    const { data } = await API.delete<AuthUser>("/user/appraiser-profile/signature");
    return data;
  },

  async uploadAppraiserCvPdf(file: File): Promise<AuthUser> {
    const body = new FormData();
    body.append("cv", file);
    const { data } = await API.post<AuthUser>("/user/appraiser-profile/cv", body);
    return data;
  },

  async deleteAppraiserCvPdf(): Promise<AuthUser> {
    const { data } = await API.delete<AuthUser>("/user/appraiser-profile/cv");
    return data;
  },
};
