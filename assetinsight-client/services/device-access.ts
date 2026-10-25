import API, { type RetriableAxiosConfig } from "@/lib/api";
import {
  clearStoredDeviceAccess,
  collectVerifiedDeviceContext,
  getDeviceKey,
  getStoredDeviceAccess,
  storeDeviceAccess,
  type RestrictedDeviceAccess,
} from "@/lib/device-access";
import { advanceAuthSession, assertAuthSessionCurrent, captureAuthSession, setTokens, type AuthSessionSnapshot } from "@/lib/auth-storage";
import type { AuthenticatedResponse } from "./auth";

function challengeHeaders() {
  const state = getStoredDeviceAccess();
  const deviceKey = getDeviceKey();
  if (!state?.challengeToken || !deviceKey) {
    throw new Error("This device request expired. Sign in again.");
  }
  return {
    Authorization: `Bearer ${state.challengeToken}`,
    "X-Device-Key": deviceKey,
  };
}

function persistRestricted(state: RestrictedDeviceAccess) {
  storeDeviceAccess(state);
  return state;
}

const challengeOptions = (session: AuthSessionSnapshot): RetriableAxiosConfig => ({ headers: challengeHeaders(), _retry: true, _authSession: session });

export const DeviceAccessService = {
  async register(): Promise<RestrictedDeviceAccess> {
    const session = advanceAuthSession();
    const context = await collectVerifiedDeviceContext();
    assertAuthSessionCurrent(session);
    const { data } = await API.post<RestrictedDeviceAccess>(
      "/auth/device-requests/register",
      {
        platform: context.platform,
        formFactor: context.formFactor,
        displayName: context.displayName,
        metadata: context.metadata,
      },
      challengeOptions(session)
    );
    assertAuthSessionCurrent(session);
    return persistRestricted(data);
  },

  async status(): Promise<RestrictedDeviceAccess & { status?: string }> {
    const session = captureAuthSession();
    const current = getStoredDeviceAccess();
    const { data } = await API.get<RestrictedDeviceAccess & { status?: string }>(
      "/auth/device-requests/status",
      challengeOptions(session)
    );
    assertAuthSessionCurrent(session);
    const authState = data.status || data.authState;
    if (authState && authState !== "approved") {
      const next = {
        ...current,
        ...data,
        authState,
        challengeToken: data.challengeToken || current?.challengeToken,
        challengeExpiresAt: data.challengeExpiresAt || current?.challengeExpiresAt,
      } as RestrictedDeviceAccess;
      persistRestricted(next);
      return next;
    }
    return data;
  },

  async exchange(): Promise<AuthenticatedResponse> {
    const session = advanceAuthSession();
    const { data } = await API.post<AuthenticatedResponse>(
      "/auth/device-requests/exchange",
      {},
      challengeOptions(session)
    );
    assertAuthSessionCurrent(session);
    setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    clearStoredDeviceAccess();
    return data;
  },

  async rerequest(): Promise<RestrictedDeviceAccess> {
    const session = advanceAuthSession();
    const { data } = await API.post<RestrictedDeviceAccess>(
      "/auth/device-requests/rerequest",
      {},
      challengeOptions(session)
    );
    assertAuthSessionCurrent(session);
    return persistRestricted(data);
  },
};
