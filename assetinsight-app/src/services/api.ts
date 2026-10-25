/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Dimensions, Platform } from "react-native";
import { API_BASE_URL, API_ENDPOINTS } from "../config/api";
import {
  clearSecureSession,
  emitRestrictedDeviceAccess,
  emitSessionInvalidated,
  getDeviceKey,
  getOrCreateDeviceKey,
  getMemoryAccessToken,
  getRefreshToken,
  setMemoryAccessToken,
} from "./deviceAccessStorage";
import { getAndroidReinstallId } from "./deviceReinstallIdentity";
import { getAppVersionLabel } from './appVersion';
import { captureAuthOperation, getAuthOperationEpoch, mutateAuthSession, staleAuthOperation } from './authSessionOperation';

declare module 'axios' {
  interface AxiosRequestConfig {
    /** One-time mutations require an explicit retry after an authentication failure. */
    skipAuthRefreshReplay?: boolean;
  }
}

// Storage keys
export const STORAGE_KEYS = {
  ACCESS_TOKEN: "cv_access_token",
  REFRESH_TOKEN: "cv_refresh_token",
  USER: "cv_user",
  SESSION_EXPIRED: "cv_session_expired",
};

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

// Request interceptor - add auth token
api.interceptors.request.use(
  async (config: any) => {
    const assertCurrent = captureAuthOperation();
    config._authEpoch = getAuthOperationEpoch();
    const token = getMemoryAccessToken();
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    const [deviceKey, reinstallId] = await Promise.all([
      getOrCreateDeviceKey(),
      getAndroidReinstallId(),
    ]);
    assertCurrent();
    if (deviceKey && config.headers) {
      config.headers["X-Device-Key"] = deviceKey;
    }
    if (reinstallId && config.headers) {
      config.headers["X-Device-Reinstall-Id"] = reinstallId;
    }
    if (config.headers) {
      const screen = Dimensions.get("screen");
      config.headers["X-Device-Platform"] = Platform.OS === "ios" ? "ios" : "android";
      config.headers["X-Activity-Source"] = Platform.OS === "ios" ? "ios" : "android";
      const appVersion = getAppVersionLabel();
      if (appVersion) config.headers["X-App-Version"] = appVersion;
      const details = config.data?.details || config.data?.formData || config.data;
      const activityId = details?.capture_id || details?.client_submission_id || details?.clientSubmissionId || config.data?.clientDraftId;
      if (typeof activityId === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(activityId)) config.headers["X-Activity-Id"] = activityId;
      config.headers["X-Device-Form-Factor"] =
        Math.min(screen.width, screen.height) >= 600 ? "tablet" : "mobile";
    }
    return config;
  },
  (error: any) => Promise.reject(error)
);

// Response interceptor - handle token refresh
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}> = [];

const processQueue = (error: unknown, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

const clearSessionAndSignalExpiry = async (assertCurrent: () => void) =>
  mutateAuthSession(assertCurrent, async () => {
    await clearSecureSession();
    assertCurrent();
    await AsyncStorage.removeItem(STORAGE_KEYS.USER);
    assertCurrent();
    await AsyncStorage.setItem(STORAGE_KEYS.SESSION_EXPIRED, "1");
    assertCurrent();
    emitSessionInvalidated();
  });

const AUTH_STATE_BY_CODE: Record<string, string> = {
  DEVICE_CONTEXT_REQUIRED: "registration_required",
  DEVICE_PENDING: "pending",
  DEVICE_REREQUEST_PENDING: "rerequest_pending",
  DEVICE_REJECTED: "rejected",
  DEVICE_REVOKED: "revoked",
  IP_BLOCKED: "ip_blocked",
};

// Public authentication actions use the submitted credentials/code, not an old
// account's refresh token. Never replay one-time actions after a 401 response.
function isPublicAuthRequest(url: unknown): boolean {
  return typeof url === 'string' && /^\/auth\/(?:login|signup|verify-email|resend-verification-code|forgot-password|reset-password-code|reset-password\/[^?]+)(?:\?|$)/.test(url);
}

api.interceptors.response.use(
  (response: any) => {
    if (response.config?._authEpoch != null && response.config._authEpoch !== getAuthOperationEpoch()) throw staleAuthOperation();
    return response;
  },
  async (error: any) => {
    const originalRequest = error.config;
    if (originalRequest?._authEpoch != null && originalRequest._authEpoch !== getAuthOperationEpoch()) return Promise.reject(staleAuthOperation());
    const assertCurrent = captureAuthOperation();
    const status = error.response?.status;
    const responseData = error.response?.data;
    const code = String(responseData?.code || "");
    const publicAuthRequest = isPublicAuthRequest(originalRequest?.url);
    if (publicAuthRequest && code === 'DEVICE_CONTEXT_REQUIRED' && !responseData?.challengeToken) {
      // Invalid request metadata is not a revocation of an existing session.
      // Keep the recovery screen/code intact and let it display the error.
      return Promise.reject(error);
    }
    const restrictedCodes = new Set([
      "DEVICE_CONTEXT_REQUIRED",
      "DEVICE_PENDING",
      "DEVICE_REREQUEST_PENDING",
      "DEVICE_REJECTED",
      "DEVICE_REVOKED",
      "IP_BLOCKED",
    ]);

    if (restrictedCodes.has(code) || responseData?.authState === "ip_blocked") {
      const restricted = {
        ...(responseData || {}),
        code,
        authState: responseData?.authState || AUTH_STATE_BY_CODE[code],
      };
      await mutateAuthSession(assertCurrent, async () => {
        await clearSecureSession(); assertCurrent();
        await AsyncStorage.multiRemove([STORAGE_KEYS.USER, STORAGE_KEYS.SESSION_EXPIRED]); assertCurrent();
        if (restricted.authState === "registration_required" && !restricted.challengeToken) emitSessionInvalidated();
        else await emitRestrictedDeviceAccess(restricted, assertCurrent);
      });
      return Promise.reject(error);
    }

    if (status === 401 && originalRequest && !originalRequest._retry && !publicAuthRequest && !originalRequest.skipAuthRefreshReplay) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            assertCurrent();
            originalRequest._retry = true;
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            return api(originalRequest);
          })
          .catch((err: any) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = await getRefreshToken();
        assertCurrent();
        if (!refreshToken) {
          processQueue(error, null);
          await clearSessionAndSignalExpiry(assertCurrent);
          return Promise.reject(error);
        }

        const [deviceKey, reinstallId] = await Promise.all([
          getDeviceKey(),
          getAndroidReinstallId(),
        ]);
        assertCurrent();
        const { data } = await axios.post(
          `${API_BASE_URL}${API_ENDPOINTS.REFRESH_TOKEN}`,
          { token: refreshToken },
          {
            timeout: 15000,
            headers: {
              ...(deviceKey ? { "X-Device-Key": deviceKey } : {}),
              ...(reinstallId ? { "X-Device-Reinstall-Id": reinstallId } : {}),
            },
          }
        );
        assertCurrent();
        const newAccessToken = data.accessToken;
        if (typeof newAccessToken !== 'string' || !newAccessToken.trim()) throw new Error('The session refresh response was incomplete. Try again when connected.');
        setMemoryAccessToken(newAccessToken);

        processQueue(null, newAccessToken);

        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        }
        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        assertCurrent();
        const restricted = (refreshError as any)?.response?.data;
        const restrictedCode = String(restricted?.code || "");
        const normalized = {
          ...(restricted || {}),
          code: restrictedCode,
          authState: restricted?.authState || AUTH_STATE_BY_CODE[restrictedCode],
        };
        if (restrictedCodes.has(restrictedCode) || Object.values(AUTH_STATE_BY_CODE).includes(normalized.authState)) {
          await mutateAuthSession(assertCurrent, async () => {
            await clearSecureSession(); assertCurrent();
            await AsyncStorage.multiRemove([STORAGE_KEYS.USER, STORAGE_KEYS.SESSION_EXPIRED]); assertCurrent();
            if (normalized.authState === "registration_required" && !normalized.challengeToken) emitSessionInvalidated();
            else await emitRestrictedDeviceAccess(normalized, assertCurrent);
          });
          return Promise.reject(refreshError);
        }
        // Connectivity loss, timeout, cancellation, malformed responses and 5xx
        // must leave the cached owner and secure refresh token available offline.
        if ([401, 403].includes((refreshError as any)?.response?.status)) {
          await clearSessionAndSignalExpiry(assertCurrent);
        }
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;
