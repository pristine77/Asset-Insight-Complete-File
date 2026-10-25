import { deleteCookie, setCookie } from "./cookies";

export type DeviceAuthState =
  | "authenticated"
  | "registration_required"
  | "pending"
  | "rerequest_pending"
  | "rejected"
  | "revoked"
  | "ip_blocked";

export type SupportContact = { name: string; email: string; phone: string };

export type RestrictedDeviceAccess = {
  authState: Exclude<DeviceAuthState, "authenticated">;
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
  };
};

export type BrowserDeviceContext = {
  installationKey: string;
  platform: "web";
  formFactor: "desktop" | "mobile" | "tablet";
  displayName: string;
  metadata: Record<string, unknown>;
};

const DEVICE_KEY = "cv_device_installation_v1";
const DEVICE_ACCESS_KEY = "cv_device_access_v1";
export const DEVICE_PENDING_COOKIE = "cv_device_pending";

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

let memoryDeviceKey: string | null = null;
let memoryDeviceAccess: RestrictedDeviceAccess | null = null;

export function getOrCreateDeviceKey(): string {
  if (typeof window === "undefined") return "";
  if (memoryDeviceKey) return memoryDeviceKey;
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing && existing.length >= 32) {
      memoryDeviceKey = existing;
      return existing;
    }
  } catch {
    // Generate an in-session key if storage is unavailable; the next visit is a new install.
  }
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  const key = toBase64Url(bytes);
  memoryDeviceKey = key;
  try {
    window.localStorage.setItem(DEVICE_KEY, key);
  } catch {}
  return key;
}

export function getDeviceKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DEVICE_KEY) || memoryDeviceKey;
  } catch {
    return memoryDeviceKey;
  }
}

export function storeDeviceAccess(value: RestrictedDeviceAccess) {
  if (typeof window === "undefined") return;
  memoryDeviceAccess = value;
  try {
    window.localStorage.setItem(DEVICE_ACCESS_KEY, JSON.stringify(value));
  } catch {}
  setCookie(DEVICE_PENDING_COOKIE, "1", 7);
}

export function getStoredDeviceAccess(): RestrictedDeviceAccess | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DEVICE_ACCESS_KEY);
    if (!raw) return memoryDeviceAccess;
    const parsed = JSON.parse(raw) as RestrictedDeviceAccess;
    if (!parsed.authState) return null;
    memoryDeviceAccess = parsed;
    return parsed;
  } catch {
    return memoryDeviceAccess;
  }
}

export function clearStoredDeviceAccess() {
  if (typeof window === "undefined") return;
  memoryDeviceAccess = null;
  try {
    window.localStorage.removeItem(DEVICE_ACCESS_KEY);
  } catch {}
  deleteCookie(DEVICE_PENDING_COOKIE);
}

function browserDetails() {
  const ua = navigator.userAgent;
  const browser = /Edg\/([\d.]+)/.exec(ua)
    ? { name: "Edge", version: /Edg\/([\d.]+)/.exec(ua)?.[1] || "" }
    : /Firefox\/([\d.]+)/.exec(ua)
      ? { name: "Firefox", version: /Firefox\/([\d.]+)/.exec(ua)?.[1] || "" }
      : /(?:Chrome|CriOS)\/([\d.]+)/.exec(ua)
        ? { name: "Chrome", version: /(?:Chrome|CriOS)\/([\d.]+)/.exec(ua)?.[1] || "" }
        : /Version\/([\d.]+).*Safari/.exec(ua)
          ? { name: "Safari", version: /Version\/([\d.]+).*Safari/.exec(ua)?.[1] || "" }
          : { name: "Browser", version: "" };
  const os = /Windows NT ([\d.]+)/.exec(ua)
    ? { name: "Windows", version: /Windows NT ([\d.]+)/.exec(ua)?.[1] || "" }
    : /Android ([\d.]+)/.exec(ua)
      ? { name: "Android", version: /Android ([\d.]+)/.exec(ua)?.[1] || "" }
      : /(?:iPhone OS|CPU OS) ([\d_]+)/.exec(ua)
        ? { name: "iOS", version: (/(?:iPhone OS|CPU OS) ([\d_]+)/.exec(ua)?.[1] || "").replaceAll("_", ".") }
        : /Mac OS X ([\d_]+)/.exec(ua)
          ? { name: "macOS", version: (/Mac OS X ([\d_]+)/.exec(ua)?.[1] || "").replaceAll("_", ".") }
          : /Linux/.test(ua)
            ? { name: "Linux", version: "" }
            : { name: "Unknown OS", version: "" };
  return { browser, os };
}

function formFactor(): "desktop" | "mobile" | "tablet" {
  const shortest = Math.min(window.screen.width, window.screen.height);
  const touch = navigator.maxTouchPoints > 0;
  if (touch && shortest >= 600) return "tablet";
  if (shortest < 600) return "mobile";
  return "desktop";
}

async function storageMetadata() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    const quotaBytes = estimate?.quota;
    const usageBytes = estimate?.usage;
    return {
      kind: "browser_origin",
      label: "Browser-origin storage quota",
      quotaBytes,
      usageBytes,
      availableBytes:
        typeof quotaBytes === "number" && typeof usageBytes === "number"
          ? Math.max(0, quotaBytes - usageBytes)
          : undefined,
    };
  } catch {
    return { kind: "browser_origin", label: "Browser-origin storage quota" };
  }
}

export async function buildBasicDeviceContext(): Promise<BrowserDeviceContext> {
  const details = browserDetails();
  const factor = formFactor();
  const storage = await storageMetadata();
  return {
    installationKey: getOrCreateDeviceKey(),
    platform: "web",
    formFactor: factor,
    displayName: `${details.os.name} ${factor} · ${details.browser.name}`,
    metadata: {
      browser: details.browser,
      os: details.os,
      screen: {
        width: window.screen.width,
        height: window.screen.height,
        availableWidth: window.screen.availWidth,
        availableHeight: window.screen.availHeight,
        pixelRatio: window.devicePixelRatio,
        colorDepth: window.screen.colorDepth,
      },
      formFactor: factor,
      storage,
    },
  };
}

function numericRange(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as { min?: unknown; max?: unknown };
  const min = typeof source.min === "number" && Number.isFinite(source.min) ? source.min : undefined;
  const max = typeof source.max === "number" && Number.isFinite(source.max) ? source.max : undefined;
  return min === undefined && max === undefined ? undefined : { min, max };
}

function sanitizeCapabilities(capabilities: MediaTrackCapabilities | undefined) {
  if (!capabilities) return {};
  const source = capabilities as MediaTrackCapabilities & Record<string, unknown>;
  return {
    width: numericRange(source.width),
    height: numericRange(source.height),
    frameRate: numericRange(source.frameRate),
    aspectRatio: numericRange(source.aspectRatio),
    facingMode: Array.isArray(source.facingMode)
      ? source.facingMode.slice(0, 6).map(String)
      : source.facingMode,
    resizeMode: Array.isArray(source.resizeMode)
      ? source.resizeMode.slice(0, 6).map(String)
      : source.resizeMode,
  };
}

export class CameraVerificationError extends Error {
  constructor(
    message: string,
    public code: "unsupported" | "denied" | "unavailable"
  ) {
    super(message);
  }
}

export async function collectVerifiedDeviceContext(): Promise<BrowserDeviceContext> {
  const context = await buildBasicDeviceContext();
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.enumerateDevices || !mediaDevices?.getUserMedia) {
    throw new CameraVerificationError(
      "This browser cannot verify camera hardware. Update the browser or use a supported device.",
      "unsupported"
    );
  }

  try {
    await mediaDevices.enumerateDevices();
  } catch {
    throw new CameraVerificationError(
      "Camera hardware could not be checked. Review browser permissions and try again.",
      "unavailable"
    );
  }
  let stream: MediaStream | null = null;
  try {
    stream = await mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    const devices = (await mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "videoinput"
    );
    const track = stream.getVideoTracks()[0];
    const capabilities = track?.getCapabilities?.();
    const settings = track?.getSettings?.();
    const activeDeviceId = settings?.deviceId;
    const orderedDevices = [...devices].sort((left, right) => {
      if (!activeDeviceId) return 0;
      if (left.deviceId === activeDeviceId) return -1;
      if (right.deviceId === activeDeviceId) return 1;
      return 0;
    });
    const safeDevices = orderedDevices.slice(0, 12).map((device, index) => {
      const active = Boolean(activeDeviceId && device.deviceId === activeDeviceId) || (!activeDeviceId && index === 0);
      return {
      label: (device.label || `Camera ${index + 1}`).slice(0, 160),
      position:
        (active ? settings?.facingMode : undefined) ||
        (/front|user/i.test(device.label) ? "front" : /back|rear|environment/i.test(device.label) ? "rear" : "unknown"),
      ...(active
        ? {
            capabilities: sanitizeCapabilities(capabilities),
            maxResolution:
              capabilities?.width && capabilities?.height
                ? `${capabilities.width.max} × ${capabilities.height.max}`
                : settings?.width && settings?.height
                  ? `${settings.width} × ${settings.height}`
                  : undefined,
          }
        : {}),
      };
    });
    return {
      ...context,
      metadata: {
        ...context.metadata,
        camera: {
          verification: "granted",
          count: safeDevices.length,
          devices: safeDevices,
        },
      },
    };
  } catch (error) {
    const domError = error as DOMException;
    if (domError?.name === "NotFoundError") {
      const retryDevices = await mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
      if (!retryDevices.some((device) => device.kind === "videoinput")) {
        return {
          ...context,
          metadata: {
            ...context.metadata,
            camera: {
              verification: "no_camera",
              verificationMethod: "get_user_media_not_found",
              count: 0,
              devices: [],
            },
          },
        };
      }
    }
    throw new CameraVerificationError(
      domError?.name === "NotAllowedError" || domError?.name === "SecurityError"
        ? "Camera access is blocked. Update your browser permissions, then try again."
        : "Camera access could not be verified. Check the camera and try again.",
      domError?.name === "NotAllowedError" || domError?.name === "SecurityError"
        ? "denied"
        : "unavailable"
    );
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
