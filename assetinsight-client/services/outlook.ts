import API from "@/lib/api";
import type { RetriableAxiosConfig } from "@/lib/api";

export type OutlookCalendarStatus = {
  connected: boolean;
  email?: string;
  connectedAt?: string | null;
  configured?: boolean;
};

export const OutlookService = {
  async getStatus(options?: Pick<RetriableAxiosConfig, "signal" | "timeout">): Promise<OutlookCalendarStatus> {
    const { data } = await API.get<OutlookCalendarStatus>(
      "/crm/calendar/ms/outlook/status", options
    );
    if (typeof data?.connected !== "boolean" || typeof data?.configured !== "boolean") {
      throw new Error("The server returned an invalid Outlook calendar status. Please refresh.");
    }
    return {
      connected: data.connected,
      email: typeof data.email === "string" ? data.email || undefined : undefined,
      connectedAt: typeof data.connectedAt === "string" ? data.connectedAt : null,
      configured: data.configured,
    };
  },

  async getAuthUrl(options?: Pick<RetriableAxiosConfig, "signal" | "timeout">): Promise<string> {
    const { data } = await API.get<{ authUrl?: string }>(
      "/crm/calendar/ms/outlook/auth-url", options
    );
    return String(data?.authUrl || "").trim();
  },

  async disconnect(options?: RetriableAxiosConfig): Promise<void> {
    await API.delete("/crm/calendar/ms/outlook/disconnect", options);
  },
};
