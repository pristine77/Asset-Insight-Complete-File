import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "@/lib/api";
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from "@/lib/auth-storage";
import { clearStoredDeviceAccess, getStoredDeviceAccess, storeDeviceAccess } from "@/lib/device-access";
import { AuthService, type AuthenticatedResponse } from "./auth";
import { DeviceAccessService } from "./device-access";

vi.mock("@/lib/device-access", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/device-access")>(),
  getDeviceKey: () => "fixture-device",
  buildBasicDeviceContext: async () => ({ installationKey: "fixture-device", platform: "web", formFactor: "desktop", displayName: "Fixture", metadata: {} }),
  collectVerifiedDeviceContext: async () => ({ installationKey: "fixture-device", platform: "web", formFactor: "desktop", displayName: "Fixture", metadata: {} }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const authenticated = (name: string): AuthenticatedResponse => ({ authState: "authenticated", user: { _id: name, email: `${name}@example.test` }, accessToken: `access-${name}`, refreshToken: `refresh-${name}` });
function response(config: InternalAxiosRequestConfig, data: unknown) { return { config, data, status: 200, statusText: "OK", headers: new AxiosHeaders() }; }
const pending = { authState: "pending" as const, code: "DEVICE_PENDING", challengeToken: "challenge-a" };

describe("auth and device persistence fences", () => {
  beforeEach(() => {
    clearTokens(); clearStoredDeviceAccess();
    API.defaults.adapter = async () => { throw new Error("Unexpected test request; network disabled"); };
  });

  it("preserves invalid-password guidance without trying to refresh an unauthenticated login", async () => {
    const urls: string[] = [];
    API.defaults.adapter = async (config) => { urls.push(config.url || ""); throw new AxiosError("Unauthorized", undefined, config, undefined, { ...response(config, { message: "Invalid email or password" }), status: 401 }); };
    await expect(AuthService.login({ email: "a@example.test", password: "wrong" })).rejects.toThrow("Invalid email or password");
    expect(urls).toEqual(["/auth/login"]); expect(getRefreshToken()).toBeNull();
  });

  it("keeps a pending login response as a device transition instead of cancelling its own operation", async () => {
    const event = vi.fn(); window.addEventListener("device-access-restricted", event);
    API.defaults.adapter = async (config) => { throw new AxiosError("Pending", undefined, config, undefined, { ...response(config, pending), status: 403 }); };
    expect(await AuthService.login({ email: "a@example.test", password: "fixture" })).toEqual(pending);
    expect(getStoredDeviceAccess()).toEqual(pending); expect(getRefreshToken()).toBeNull();
    expect(event).not.toHaveBeenCalled();
    window.removeEventListener("device-access-restricted", event);
  });

  it.each(["success", "restriction"])("an old login %s cannot overwrite the newer authenticated session", async (outcome) => {
    const gate = deferred<void>(); let started = false;
    API.defaults.adapter = async (config) => {
      if (JSON.parse(config.data).email === "a@example.test") {
        started = true; await gate.promise;
        if (outcome === "restriction") throw new AxiosError("Pending", undefined, config, undefined, { ...response(config, pending), status: 403 });
        return response(config, authenticated("a"));
      }
      return response(config, authenticated("b"));
    };
    const old = AuthService.login({ email: "a@example.test", password: "fixture" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(started).toBe(true));
    await AuthService.login({ email: "b@example.test", password: "fixture" });
    gate.resolve(); expect(await old).toMatchObject({ code: "ERR_CANCELED" });
    expect(getAccessToken()).toBe("access-b"); expect(getStoredDeviceAccess()).toBeNull();
  });

  it("clears logout locally before the request and a late receipt cannot clear a later login", async () => {
    setTokens(authenticated("a")); storeDeviceAccess(pending);
    const gate = deferred<void>(); const calls: InternalAxiosRequestConfig[] = [];
    API.defaults.adapter = async (config) => { calls.push(config); await gate.promise; return response(config, {}); };
    const logout = AuthService.logout();
    expect(getRefreshToken()).toBeNull(); expect(getStoredDeviceAccess()).toBeNull();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].headers.Authorization).toBe("Bearer access-a");
    expect(calls[0]).toMatchObject({ timeout: 15_000, _retry: true });
    setTokens(authenticated("b")); gate.resolve(); await logout;
    expect(getAccessToken()).toBe("access-b");
  });

  it.each(["verify", "reset-code", "reset-token"])("stale %s authentication cannot restore tokens after logout", async (method) => {
    const gate = deferred<void>(); let started = false;
    API.defaults.adapter = async (config) => { started = true; await gate.promise; return response(config, authenticated("a")); };
    const pendingResult = method === "verify" ? AuthService.verifyEmail({ email: "a@example.test", verificationCode: "fixture" })
      : method === "reset-code" ? AuthService.resetPasswordByCode({ email: "a@example.test", code: "fixture", password: "fixture" })
        : AuthService.resetPassword({ token: "fixture", password: "fixture" });
    const result = pendingResult.catch((error: unknown) => error);
    await vi.waitFor(() => expect(started).toBe(true)); clearTokens(); gate.resolve();
    expect(await result).toMatchObject({ code: "ERR_CANCELED" }); expect(getAccessToken()).toBeNull();
  });

  it.each(["status", "register", "rerequest", "exchange"])("a stale device %s cannot persist challenge or tokens after another login", async (method) => {
    storeDeviceAccess(pending);
    const gate = deferred<void>(); let started = false;
    API.defaults.adapter = async (config) => { started = true; await gate.promise; return response(config, method === "exchange" ? authenticated("a") : { ...pending, challengeToken: "obsolete" }); };
    const result = DeviceAccessService[method as "status" | "register" | "rerequest" | "exchange"]().catch((error: unknown) => error);
    await vi.waitFor(() => expect(started).toBe(true)); setTokens(authenticated("b")); clearStoredDeviceAccess(); gate.resolve();
    expect(await result).toMatchObject({ code: "ERR_CANCELED" });
    expect(getAccessToken()).toBe("access-b"); expect(getStoredDeviceAccess()).toBeNull();
  });
});
