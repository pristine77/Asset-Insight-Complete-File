/**
 * Microsoft Outlook calendar connection for CRM agents: app configuration and
 * a valid access token per user (refreshed and stored when it is about to
 * expire). Moved unchanged from controller/crm.controller.ts on 2026-10-11 so
 * the CRM follow-up job (crmFollowUpOutlookService.ts) can keep follow-up
 * events in step without importing a controller. The OAuth connect/disconnect
 * endpoints stay in the controller.
 */
import axios from "axios";
import User from "../models/user.model.js";

export const MS_GRAPH_AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MS_GRAPH_TOKEN_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const MS_GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";

function toNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

export function formatAxiosErrorForLog(err: any) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  return {
    status: typeof status === "number" ? status : undefined,
    code: err?.code,
    message: err?.message,
    msError: data?.error,
    msErrorDescription: data?.error_description,
    msRequestId: data?.trace_id || data?.correlation_id || err?.response?.headers?.["x-ms-request-id"],
  };
}

export function getMsOutlookScopes() {
  return (
    process.env.MS_OUTLOOK_SCOPES ||
    "offline_access User.Read Calendars.ReadWrite"
  );
}

export function getMsOutlookRedirectUri() {
  return toNonEmptyString(process.env.MS_OUTLOOK_REDIRECT_URI);
}

export function getMsOutlookClientId() {
  return toNonEmptyString(process.env.MS_OUTLOOK_CLIENT_ID);
}

export function getMsOutlookClientSecret() {
  return toNonEmptyString(process.env.MS_OUTLOOK_CLIENT_SECRET);
}

export function isMsOutlookConfigured() {
  return Boolean(getMsOutlookClientId() && getMsOutlookClientSecret() && getMsOutlookRedirectUri());
}

export async function refreshMicrosoftAccessToken(refreshToken: string) {
  type MsTokenResponse = {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const clientId = getMsOutlookClientId();
  const clientSecret = getMsOutlookClientSecret();
  const redirectUri = getMsOutlookRedirectUri();

  const payload = new URLSearchParams();
  payload.set("client_id", clientId);
  payload.set("client_secret", clientSecret);
  payload.set("refresh_token", refreshToken);
  payload.set("grant_type", "refresh_token");
  payload.set("redirect_uri", redirectUri);
  payload.set("scope", getMsOutlookScopes());

  const { data } = await axios.post<MsTokenResponse>(MS_GRAPH_TOKEN_BASE, payload.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 15000,
  });

  return {
    accessToken: toNonEmptyString(data?.access_token),
    refreshToken: toNonEmptyString(data?.refresh_token || refreshToken),
    expiresIn: Number(data?.expires_in || 0),
  };
}

export async function getValidMicrosoftAccessTokenForUser(userId: string) {
  const user = await User.findById(userId).select(
    "+msOutlookAccessToken +msOutlookRefreshToken msOutlookTokenExpiresAt"
  );
  if (!user) throw new Error("User not found");

  const accessToken = toNonEmptyString((user as any)?.msOutlookAccessToken);
  const refreshToken = toNonEmptyString((user as any)?.msOutlookRefreshToken);
  const expiresAt = (user as any)?.msOutlookTokenExpiresAt
    ? new Date((user as any).msOutlookTokenExpiresAt)
    : undefined;
  const validForAtLeast = Date.now() + 60 * 1000;

  if (accessToken && expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > validForAtLeast) {
    return accessToken;
  }

  if (!refreshToken) {
    throw new Error("Microsoft calendar is not connected");
  }

  const refreshed = await refreshMicrosoftAccessToken(refreshToken);
  const nextExpiresAt =
    refreshed.expiresIn > 0
      ? new Date(Date.now() + refreshed.expiresIn * 1000)
      : new Date(Date.now() + 45 * 60 * 1000);

  await User.updateOne(
    { _id: userId },
    {
      $set: {
        msOutlookCalendarConnected: true,
        msOutlookAccessToken: refreshed.accessToken,
        msOutlookRefreshToken: refreshed.refreshToken || undefined,
        msOutlookTokenExpiresAt: nextExpiresAt,
      },
    }
  );

  return refreshed.accessToken;
}
