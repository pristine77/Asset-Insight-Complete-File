"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AuthResponse, AuthUser, LoginPayload } from "@/services/auth";
import { AuthService } from "@/services/auth";
import { UserService } from "@/services/user";
import { AuthSessionChangedError, captureAuthSession, clearTokens, hasStoredTokens, isAuthSessionCurrent } from "@/lib/auth-storage";
import {
  clearStoredDeviceAccess,
  getStoredDeviceAccess,
  storeDeviceAccess,
  type RestrictedDeviceAccess,
} from "@/lib/device-access";
import { DeviceAccessService } from "@/services/device-access";

export type AuthContextType = {
  user: AuthUser | null;
  sessionPresent: boolean;
  loading: boolean;
  error: string | null;
  loggingOut: boolean;
  deviceAccess: RestrictedDeviceAccess | null;
  refresh: () => Promise<void>;
  login: (payload: LoginPayload) => Promise<AuthResponse>;
  acceptAuthResponse: (response: AuthResponse) => AuthResponse;
  registerDevice: () => Promise<void>;
  refreshDeviceStatus: () => Promise<void>;
  rerequestDevice: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sessionPresent, setSessionPresent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [deviceAccess, setDeviceAccess] = useState<RestrictedDeviceAccess | null>(null);
  const statusRequest = useRef<Promise<void> | null>(null);
  const operation = useRef(0);
  const identityPending = useRef(false);
  const mounted = useRef(true);
  const beginOperation = useCallback((pendingIdentity = false) => {
    statusRequest.current = null;
    identityPending.current = pendingIdentity;
    return ++operation.current;
  }, []);
  const isCurrent = useCallback((request: number) => mounted.current && operation.current === request, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current += 1; };
  }, []);

  const applyResponse = useCallback((data: AuthResponse) => {
    beginOperation();
    if (data.authState === "authenticated") {
      setUser(data.user);
      setSessionPresent(true);
      setDeviceAccess(null);
      clearStoredDeviceAccess();
    } else {
      setUser(null);
      setSessionPresent(false);
      setDeviceAccess(data);
      storeDeviceAccess(data);
    }
    return data;
  }, [beginOperation]);

  const refresh = useCallback(async () => {
    // A background read must not supersede the identity a login/exchange is about to commit.
    if (identityPending.current) return;
    const request = beginOperation();
    const session = captureAuthSession();
    setError(null);
    try {
      const me = await UserService.getMe();
      if (!isCurrent(request) || !isAuthSessionCurrent(session)) return;
      setUser(me);
      setSessionPresent(true);
      setLoggingOut(false);
    } catch (err: any) {
      if (!isCurrent(request) || !isAuthSessionCurrent(session)) return;
      setUser(null);
      setSessionPresent(false);
      const restricted = err?.response?.data as RestrictedDeviceAccess | undefined;
      if (restricted?.authState) {
        setDeviceAccess(restricted);
        storeDeviceAccess(restricted);
        clearTokens();
      } else {
        setError(
          err?.response?.data?.message || err?.message || "Unable to load your account"
        );
        clearTokens();
      }
    }
  }, [beginOperation, isCurrent]);

  const login = useCallback(
    async (payload: LoginPayload) => {
      const request = beginOperation(true);
      setError(null);
      setLoggingOut(false);
      try {
        const data = await AuthService.login(payload);
        if (!isCurrent(request)) throw new AuthSessionChangedError();
        return applyResponse(data);
      } finally {
        if (isCurrent(request)) identityPending.current = false;
      }
    },
    [applyResponse, beginOperation, isCurrent]
  );

  const exchangeIfApproved = useCallback(async (request: number) => {
    identityPending.current = true;
    try {
      const authenticated = await DeviceAccessService.exchange();
      if (!isCurrent(request)) throw new AuthSessionChangedError();
      setUser(authenticated.user);
      setSessionPresent(true);
      setDeviceAccess(null);
      setError(null);
    } finally {
      if (isCurrent(request)) identityPending.current = false;
    }
  }, [isCurrent]);

  const registerDevice = useCallback(async () => {
    const request = beginOperation(true);
    try {
      const next = await DeviceAccessService.register();
      if (!isCurrent(request)) throw new AuthSessionChangedError();
      if ((next as unknown as { authState?: string }).authState === "approved") {
        await exchangeIfApproved(request);
        return;
      }
      setDeviceAccess(next);
    } finally {
      if (isCurrent(request)) identityPending.current = false;
    }
  }, [beginOperation, exchangeIfApproved, isCurrent]);

  const refreshDeviceStatus = useCallback(() => {
    if (statusRequest.current) return statusRequest.current;
    if (identityPending.current) return Promise.resolve();
    const request = beginOperation();
    const promise = (async () => {
      const result = await DeviceAccessService.status();
      if (!isCurrent(request)) throw new AuthSessionChangedError();
      const status = result.status || result.authState;
      if (status === "approved") {
        await exchangeIfApproved(request);
        return;
      }
      const next = { ...result, authState: status } as RestrictedDeviceAccess;
      setDeviceAccess(next);
      storeDeviceAccess(next);
    })().finally(() => {
      if (statusRequest.current === promise) statusRequest.current = null;
    });
    statusRequest.current = promise;
    return promise;
  }, [beginOperation, exchangeIfApproved, isCurrent]);

  const rerequestDevice = useCallback(async () => {
    const request = beginOperation(true);
    try {
      const next = await DeviceAccessService.rerequest();
      if (!isCurrent(request)) throw new AuthSessionChangedError();
      setDeviceAccess(next);
    } finally {
      if (isCurrent(request)) identityPending.current = false;
    }
  }, [beginOperation, isCurrent]);

  const logout = useCallback(async () => {
    const request = beginOperation(true);
    setLoggingOut(true);
    setUser(null);
    setSessionPresent(false);
    setDeviceAccess(null);
    try {
      await AuthService.logout();
    } finally {
      if (isCurrent(request)) { identityPending.current = false; setLoggingOut(false); }
    }
  }, [beginOperation, isCurrent]);

  useEffect(() => {
    const storedDeviceAccess = getStoredDeviceAccess();
    if (storedDeviceAccess) {
      setDeviceAccess(storedDeviceAccess);
      setUser(null);
      setSessionPresent(false);
      setLoggingOut(false);
      setLoading(false);
    } else if (typeof window !== "undefined" && hasStoredTokens()) {
      setSessionPresent(true);
      refresh().finally(() => setLoading(false));
    } else {
      clearTokens();
      setUser(null);
      setSessionPresent(false);
      setLoggingOut(false);
      setLoading(false);
    }
  }, [refresh]);

  useEffect(() => {
    const onRestricted = (event: Event) => {
      const detail = (event as CustomEvent<RestrictedDeviceAccess>).detail;
      if (!detail?.authState) return;
      beginOperation();
      clearTokens();
      setUser(null);
      setLoggingOut(false);
      setSessionPresent(false);
      setDeviceAccess(detail);
      storeDeviceAccess(detail);
    };
    window.addEventListener("device-access-restricted", onRestricted);
    return () => window.removeEventListener("device-access-restricted", onRestricted);
  }, [beginOperation]);

  useEffect(() => {
    const onSessionInvalidated = () => {
      beginOperation();
      clearTokens();
      clearStoredDeviceAccess();
      setUser(null);
      setSessionPresent(false);
      setDeviceAccess(null);
      setLoggingOut(false);
      setError("Your device session is no longer valid. Sign in again to continue.");
    };
    window.addEventListener("auth-session-invalidated", onSessionInvalidated);
    return () => window.removeEventListener("auth-session-invalidated", onSessionInvalidated);
  }, [beginOperation]);

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      sessionPresent,
      loading,
      error,
      loggingOut,
      deviceAccess,
      refresh,
      login,
      acceptAuthResponse: applyResponse,
      registerDevice,
      refreshDeviceStatus,
      rerequestDevice,
      logout,
    }),
    [
      user,
      sessionPresent,
      loading,
      error,
      loggingOut,
      deviceAccess,
      refresh,
      login,
      applyResponse,
      registerDevice,
      refreshDeviceStatus,
      rerequestDevice,
      logout,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuthContext must be used within AuthProvider");
  return ctx;
}
