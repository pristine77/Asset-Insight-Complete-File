import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { captureAuthOperation, mutateAuthSession } from './authSessionOperation';

export type DeviceAuthState =
  | "registration_required"
  | "pending"
  | "rerequest_pending"
  | "rejected"
  | "revoked"
  | "ip_blocked";

export interface SupportContact {
  name: string;
  email: string;
  phone: string;
}

export interface RestrictedDeviceAccess {
  authState: DeviceAuthState;
  status?: string;
  code?: string;
  message?: string;
  challengeToken?: string;
  challengeExpiresAt?: string;
  reason?: string;
  retryAfterSeconds?: number;
  supportContact?: SupportContact;
  device?: {
    id: string;
    status: string;
    displayName?: string;
    platform?: string;
    formFactor?: string;
    requestCount?: number;
    requestedAt?: string;
    reason?: string;
    lastIp?: string;
    camera?: {
      verification?: string;
      count?: number;
      rearMaximumMegapixels?: number;
      aggregateMegapixels?: number;
    };
  };
}

const DEVICE_KEY = "cv_device_installation_secure_v1";
const DEVICE_ACCESS_KEY = "cv_device_access_secure_v1";
const REFRESH_TOKEN_KEY = "cv_refresh_token_secure_v1";
const LEGACY_ACCESS_KEY = "cv_access_token";
const LEGACY_REFRESH_KEY = "cv_refresh_token";

let accessTokenMemory: string | null = null;
let deviceKeyCreation: Promise<string> | null = null;
const listeners = new Set<(state: RestrictedDeviceAccess | null) => void>();
const sessionListeners = new Set<() => void>();

function notify(state: RestrictedDeviceAccess | null) {
  listeners.forEach((listener) => listener(state));
}

export function subscribeDeviceAccess(
  listener: (state: RestrictedDeviceAccess | null) => void
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeSessionInvalidated(listener: () => void) {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

export function emitSessionInvalidated() {
  sessionListeners.forEach((listener) => listener());
}

export function setMemoryAccessToken(token: string | null) {
  accessTokenMemory = token;
}

export function getMemoryAccessToken() {
  return accessTokenMemory;
}

export async function setRefreshToken(token: string | null) {
  if (token) {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  }
}

export async function getRefreshToken() {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function getOrCreateDeviceKey() {
  // Startup and password-reset requests can run concurrently. Share one
  // creation promise so every request from this installation uses the same key.
  if (!deviceKeyCreation) {
    deviceKeyCreation = (async () => {
      const existing = await SecureStore.getItemAsync(DEVICE_KEY);
      // The server trims the installation key before validating it. Preserve
      // every usable identity exactly, but do not send a corrupt padded value
      // whose apparent length passes here and is rejected during authentication.
      if (existing && existing.trim().length >= 32) return existing;

      const bytes = await Crypto.getRandomBytesAsync(32);
      const key = Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      await SecureStore.setItemAsync(DEVICE_KEY, key, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      return key;
    })().finally(() => {
      deviceKeyCreation = null;
    });
  }

  return deviceKeyCreation;
}

export async function getDeviceKey() {
  return SecureStore.getItemAsync(DEVICE_KEY);
}

export async function persistDeviceAccess(state: RestrictedDeviceAccess, assertCurrent = captureAuthOperation()) {
  assertCurrent();
  await SecureStore.setItemAsync(DEVICE_ACCESS_KEY, JSON.stringify(state), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  assertCurrent();
  notify(state);
  return state;
}

export async function getPersistedDeviceAccess() {
  try {
    const raw = await SecureStore.getItemAsync(DEVICE_ACCESS_KEY);
    return raw ? (JSON.parse(raw) as RestrictedDeviceAccess) : null;
  } catch {
    return null;
  }
}

export async function clearDeviceAccess(assertCurrent = captureAuthOperation()) {
  assertCurrent();
  await SecureStore.deleteItemAsync(DEVICE_ACCESS_KEY);
  assertCurrent();
  notify(null);
}

export async function clearSecureSession() {
  setMemoryAccessToken(null);
  await Promise.all([
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    AsyncStorage.multiRemove([LEGACY_ACCESS_KEY, LEGACY_REFRESH_KEY]),
  ]);
}

export async function migrateLegacyTokens() {
  const assertCurrent = captureAuthOperation();
  const [legacyAccess, legacyRefresh, secureRefresh] = await Promise.all([
    AsyncStorage.getItem(LEGACY_ACCESS_KEY),
    AsyncStorage.getItem(LEGACY_REFRESH_KEY),
    getRefreshToken(),
  ]);
  await mutateAuthSession(assertCurrent, async () => {
    if (legacyAccess) setMemoryAccessToken(legacyAccess);
    if (!secureRefresh && legacyRefresh) await setRefreshToken(legacyRefresh);
    assertCurrent();
    await AsyncStorage.multiRemove([LEGACY_ACCESS_KEY, LEGACY_REFRESH_KEY]);
  });
}

export async function emitRestrictedDeviceAccess(value: unknown, assertCurrent = captureAuthOperation()) {
  const data = value as RestrictedDeviceAccess | undefined;
  if (!data?.authState) return;
  await persistDeviceAccess(data, assertCurrent);
}
