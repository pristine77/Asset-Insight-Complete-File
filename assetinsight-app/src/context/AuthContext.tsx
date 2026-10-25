import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from "react";
import authService, { User, LoginCredentials, type AuthResponse } from "../services/authService";
import offlineQueueService from "../services/offlineQueueService";
import { unregisterStoredPushTokenFromServer } from "../services/notificationService";
import deviceAccessService, { type ApprovedDeviceAccess } from "../services/deviceAccessService";
import NetInfo from '@react-native-community/netinfo';
import OfflineCaptureStore from '../services/offlineCaptureStore';
import AutoSaveService from '../services/autoSaveService';
import OfflineCaptureSync from '../services/offlineCaptureSync';
import CaptureBackupService from '../services/captureBackupService';
import { pauseActiveUploads } from '../services/uploadCancellation';
import { captureAuthOperation, invalidateAuthOperations, staleAuthOperation } from '../services/authSessionOperation';
import {
  getPersistedDeviceAccess,
  subscribeDeviceAccess,
  subscribeSessionInvalidated,
  type RestrictedDeviceAccess,
} from "../services/deviceAccessStorage";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isAuthenticated: boolean;
  deviceAccess: RestrictedDeviceAccess | null;
  login: (credentials: LoginCredentials) => Promise<AuthResponse>;
  registerDevice: () => Promise<void>;
  refreshDeviceStatus: () => Promise<void>;
  rerequestDevice: () => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  error: string | null;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deviceAccess, setDeviceAccess] = useState<RestrictedDeviceAccess | null>(null);
  const statusRequest = useRef<Promise<void> | null>(null);
  const authEpoch = useRef(0);
  const bindUser = useCallback(async (next: User | null, assertCurrent: () => void = () => undefined) => {
    assertCurrent();
    const owner = next ? String(next._id || (next as any).id || '') : null;
    if (OfflineCaptureStore.getOwnerId() !== owner) {
      if (OfflineCaptureStore.getOwnerId() || !owner) await CaptureBackupService.deactivate();
      assertCurrent();
      pauseActiveUploads(undefined, 'lifecycle');
      OfflineCaptureSync.cleanup();
      offlineQueueService.cleanup();
    }
    AutoSaveService.setOwner(owner);
    if (owner) await OfflineCaptureStore.initialize();
    assertCurrent();
    if (OfflineCaptureStore.getOwnerId() !== owner) return;
    setUser(next);
  }, []);

  const refreshUser = useCallback(async () => {
    const generation = authEpoch.current;
    const assertCurrent = captureAuthOperation();
    const connectivity = await NetInfo.fetch();
    assertCurrent();
    const currentUser =
      (connectivity.isConnected === false || connectivity.isInternetReachable === false ? null : await authService.refreshCurrentUser(assertCurrent)) ||
      (await authService.getCurrentUser());
    if (generation === authEpoch.current) await bindUser(currentUser, assertCurrent);
  }, [bindUser]);

  const checkAuth = useCallback(async () => {
    const generation = authEpoch.current;
    try {
      setLoading(true);
      const restricted = await getPersistedDeviceAccess();
      if (generation !== authEpoch.current) return;
      if (restricted) {
        await CaptureBackupService.deactivate();
        if (generation !== authEpoch.current) return;
        setDeviceAccess(restricted);
        setUser(null);
        AutoSaveService.setOwner(null);
        offlineQueueService.cleanup();
        return;
      }
      const isAuth = await authService.isAuthenticated();
      if (generation !== authEpoch.current) return;
      if (isAuth) {
        await refreshUser();
        if (generation === authEpoch.current && OfflineCaptureStore.getOwnerId()) offlineQueueService.init();
      } else await CaptureBackupService.deactivate();
    } catch (err) {
      console.error("Auth check failed:", err);
    } finally {
      if (generation === authEpoch.current) setLoading(false);
    }
  }, [refreshUser]);

  useEffect(() => {
    void checkAuth();
    return () => { authEpoch.current++; invalidateAuthOperations(); };
  }, [checkAuth]);

  useEffect(() => {
    return subscribeDeviceAccess((state) => {
      setDeviceAccess(state);
      if (state) {
        void CaptureBackupService.deactivate();
        authEpoch.current++;
        invalidateAuthOperations();
        setLoading(false);
        statusRequest.current = null;
        pauseActiveUploads(undefined, 'lifecycle');
        OfflineCaptureSync.cleanup();
        AutoSaveService.setOwner(null);
        setUser(null);
        offlineQueueService.cleanup();
      }
    });
  }, []);

  useEffect(() => {
    return subscribeSessionInvalidated(() => {
      void CaptureBackupService.deactivate();
      authEpoch.current++;
      invalidateAuthOperations();
      setLoading(false);
      statusRequest.current = null;
      pauseActiveUploads(undefined, 'lifecycle');
      OfflineCaptureSync.cleanup();
      AutoSaveService.setOwner(null);
      setUser(null);
      setDeviceAccess(null);
      setError("Your device session is no longer valid. Sign in again to continue.");
      offlineQueueService.cleanup();
    });
  }, []);

  const login = async (credentials: LoginCredentials) => {
    const generation = ++authEpoch.current;
    invalidateAuthOperations();
    const assertCurrent = captureAuthOperation();
    try {
      setLoading(true);
      setError(null);
      const response = await authService.login(credentials, assertCurrent);
      // A restricted response publishes its own device event, which deliberately
      // invalidates this operation. Do not overwrite that authoritative event.
      if (response.authState !== 'authenticated' && generation !== authEpoch.current) return response;
      assertCurrent();
      if (response.authState === "authenticated") {
        await bindUser(response.user, assertCurrent);
        setDeviceAccess(null);
        offlineQueueService.init();
      } else {
        await bindUser(null, assertCurrent);
        setDeviceAccess(response);
        offlineQueueService.cleanup();
      }
      return response;
    } catch (err: any) {
      if (generation !== authEpoch.current) throw staleAuthOperation();
      const message = err.response?.data?.message || err.message || "Login failed";
      setError(message);
      throw Object.assign(new Error(message), { code: err.response?.data?.code || err.code });
    } finally {
      if (generation === authEpoch.current) setLoading(false);
    }
  };

  const exchangeApproval = useCallback(async (assertCurrent = captureAuthOperation(), approved?: ApprovedDeviceAccess) => {
    assertCurrent();
    const response = await deviceAccessService.exchange(assertCurrent, approved);
    assertCurrent();
    await bindUser(response.user, assertCurrent);
    setDeviceAccess(null);
    setError(null);
    offlineQueueService.init();
  }, [bindUser]);

  const registerDevice = useCallback(async () => {
    const generation = authEpoch.current;
    const assertCurrent = captureAuthOperation();
    const response = await deviceAccessService.register(assertCurrent);
    if (response.authState === "approved") {
      assertCurrent();
      await exchangeApproval(assertCurrent, response);
      return;
    }
    if (generation === authEpoch.current) setDeviceAccess(response);
  }, [exchangeApproval]);

  const refreshDeviceStatus = useCallback(() => {
    if (statusRequest.current) return statusRequest.current;
    const generation = authEpoch.current;
    const assertCurrent = captureAuthOperation();
    const request = (async () => {
      const response = await deviceAccessService.status(assertCurrent);
      const status = response.status || response.authState;
      if (status === "approved") {
        assertCurrent();
        await exchangeApproval(assertCurrent);
        return;
      }
      const next = { ...response, authState: status } as RestrictedDeviceAccess;
      if (generation === authEpoch.current) setDeviceAccess(next);
    })().finally(() => {
      if (statusRequest.current === request) statusRequest.current = null;
    });
    statusRequest.current = request;
    return request;
  }, [exchangeApproval]);

  const rerequestDevice = useCallback(async () => {
    const generation = authEpoch.current;
    const response = await deviceAccessService.rerequest(captureAuthOperation());
    if (generation === authEpoch.current) setDeviceAccess(response);
  }, []);

  const logout = async () => {
    const generation = ++authEpoch.current;
    invalidateAuthOperations();
    const assertCurrent = captureAuthOperation();
    statusRequest.current = null;
    try {
      await bindUser(null, assertCurrent);
      setLoading(true);
      offlineQueueService.cleanup();
      await unregisterStoredPushTokenFromServer().catch((error) => {
        console.error("Notification token cleanup failed:", error);
      });
      assertCurrent();
      await authService.logout();
      assertCurrent();
      setUser(null);
      setDeviceAccess(null);
    } catch (err) {
      console.error("Logout failed:", err);
    } finally {
      if (generation === authEpoch.current) setLoading(false);
    }
  };

  const clearError = useCallback(() => setError(null), []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAuthenticated: !!user,
        deviceAccess,
        login,
        registerDevice,
        refreshDeviceStatus,
        rerequestDevice,
        logout,
        refreshUser,
        error,
        clearError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
