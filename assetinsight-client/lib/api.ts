import axios, { AxiosRequestConfig } from "axios";
import { API_BASE } from "./config";
import {
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  clearTokens,
  captureAuthSession,
  isAuthSessionCurrent,
  assertAuthSessionCurrent,
  AuthSessionChangedError,
  type AuthSessionSnapshot,
} from "./auth-storage";
import { getDeviceKey, type RestrictedDeviceAccess } from "./device-access";

const API = axios.create({
  baseURL: API_BASE,
  timeout: 600000, // 10 minutes
});

API.interceptors.request.use((config) => {
  const scoped = config as typeof config & { _authSession?: AuthSessionSnapshot };
  scoped._authSession ??= captureAuthSession();
  assertAuthSessionCurrent(scoped._authSession);
  config.headers["X-Activity-Source"] = "web";
  const details = config.data?.details || config.data?.formData || config.data;
  const activityId = details?.activity_id || details?.capture_id || config.data?.clientDraftId || details?.client_submission_id || details?.clientSubmissionId;
  if (typeof activityId === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(activityId)) config.headers["X-Activity-Id"] = activityId;
  const token = getAccessToken();
  if (token) {
    config.headers = config.headers || {};
    (config.headers as any).Authorization = `Bearer ${token}`;
  }
  const deviceKey = getDeviceKey();
  if (deviceKey) {
    config.headers = config.headers || {};
    (config.headers as any)["X-Device-Key"] = deviceKey;
  }
  (config.headers as any).Accept = (config.headers as any).Accept || "application/json";
  const method = (config.method || 'get').toUpperCase();
  const isForm = typeof FormData !== 'undefined' && config.data instanceof FormData;
  if (!isForm && (method !== 'GET' || config.data !== undefined)) {
    (config.headers as any)["Content-Type"] = (config.headers as any)["Content-Type"] || "application/json";
  }
  return config;
}, undefined, { synchronous: true });

let refreshFlight: { session: AuthSessionSnapshot; promise: Promise<string> } | null = null;
let sessionInvalidationEmitted = false;
export type RetriableAxiosConfig = AxiosRequestConfig & { _retry?: boolean; _authSession?: AuthSessionSnapshot };

const DEVICE_ACCESS_CODES = new Set([
  "DEVICE_CONTEXT_REQUIRED",
  "DEVICE_PENDING",
  "DEVICE_REREQUEST_PENDING",
  "DEVICE_REJECTED",
  "DEVICE_REVOKED",
  "IP_BLOCKED",
]);

function ownsAuthenticationResponse(url: string | undefined) {
  return url === "/auth/login" || url === "/auth/verify-email" ||
    url === "/auth/reset-password-code" || Boolean(url?.startsWith("/auth/reset-password/"));
}

function emitRestrictedAccess(data: RestrictedDeviceAccess | undefined) {
  if (typeof window === "undefined" || !data?.authState) return;
  window.dispatchEvent(
    new CustomEvent("device-access-restricted", { detail: data })
  );
}

const AUTH_STATE_BY_CODE: Record<string, RestrictedDeviceAccess["authState"]> = {
  DEVICE_CONTEXT_REQUIRED: "registration_required",
  DEVICE_PENDING: "pending",
  DEVICE_REREQUEST_PENDING: "rerequest_pending",
  DEVICE_REJECTED: "rejected",
  DEVICE_REVOKED: "revoked",
  IP_BLOCKED: "ip_blocked",
};

function normalizeRestrictedAccess(
  data: RestrictedDeviceAccess | undefined,
  code: string
): RestrictedDeviceAccess | undefined {
  const authState = data?.authState || AUTH_STATE_BY_CODE[code];
  return authState ? { ...(data || {}), authState, code } : undefined;
}

function invalidateSession() {
  clearTokens();
  if (typeof window !== "undefined" && !sessionInvalidationEmitted) {
    sessionInvalidationEmitted = true;
    window.dispatchEvent(new Event("auth-session-invalidated"));
  }
}

API.interceptors.response.use(
  (response) => {
    const session = (response.config as RetriableAxiosConfig)._authSession;
    if (session) assertAuthSessionCurrent(session);
    if (getAccessToken()) sessionInvalidationEmitted = false;
    return response;
  },
  async (error: any) => {
    const originalRequest: RetriableAxiosConfig = error.config || {};
    const session = originalRequest._authSession;
    if (session && !isAuthSessionCurrent(session)) return Promise.reject(new AuthSessionChangedError());
    const status = error?.response?.status;
    const responseData = error?.response?.data as RestrictedDeviceAccess | undefined;
    const responseCode = String((responseData as any)?.code || "");

    // Authentication owns its restricted response. Dispatching it here can
    // invalidate the same verification/reset attempt before it handles receipt.
    if ((DEVICE_ACCESS_CODES.has(responseCode) || responseData?.authState === "ip_blocked") && !ownsAuthenticationResponse(originalRequest.url)) {
      const restricted = normalizeRestrictedAccess(responseData, responseCode);
      if (restricted?.authState === "registration_required" && !restricted.challengeToken) {
        invalidateSession();
      } else {
        emitRestrictedAccess(restricted);
      }
      return Promise.reject(error);
    }

    // A 403 is normally an authorization decision, not an expired access
    // token. Refreshing on every 403 caused request storms and masked genuine
    // permissions errors.
    if (status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      const refreshSession = session || captureAuthSession();
      if (!refreshFlight || !isAuthSessionCurrent(refreshFlight.session)) {
        const flight = { session: refreshSession, promise: Promise.resolve("") };
        flight.promise = (async () => {
          const currentRefreshToken = getRefreshToken();
          if (!currentRefreshToken) {
            invalidateSession();
            throw error;
          }
          try {
            const { data } = await axios.post<{ accessToken?: string }>(
              `${API_BASE}/auth/refresh-token`,
              { token: currentRefreshToken },
              { headers: getDeviceKey() ? { "X-Device-Key": getDeviceKey() as string } : undefined }
            );
            assertAuthSessionCurrent(refreshSession);
            const newAccessToken = data?.accessToken;
            if (!newAccessToken) throw new Error("No access token returned from refresh");
            setAccessToken(newAccessToken);
            sessionInvalidationEmitted = false;
            return newAccessToken;
          } catch (refreshError) {
            if (!isAuthSessionCurrent(refreshSession)) throw new AuthSessionChangedError();
            const refreshData = (refreshError as any)?.response?.data as RestrictedDeviceAccess | undefined;
            const refreshStatus = Number((refreshError as any)?.response?.status || 0);
            const refreshCode = String((refreshData as any)?.code || "");
            const restricted = normalizeRestrictedAccess(refreshData, refreshCode);
            if (restricted?.authState === "registration_required" && !restricted.challengeToken) {
              invalidateSession();
            } else if (restricted?.authState) {
              emitRestrictedAccess(restricted);
              clearTokens();
            } else if (refreshStatus >= 400 && refreshStatus < 500) {
              // Terminal only for the session whose refresh actually failed.
              invalidateSession();
            }
            throw refreshError;
          }
        })().finally(() => { if (refreshFlight === flight) refreshFlight = null; });
        refreshFlight = flight;
      }
      const token = await refreshFlight.promise;
      assertAuthSessionCurrent(refreshSession);
      originalRequest.headers = originalRequest.headers || {};
      (originalRequest.headers as any).Authorization = `Bearer ${token}`;
      return API(originalRequest);
    }

    return Promise.reject(error);
  }
);

export default API;
