import axios, { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "./api";
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from "./auth-storage";

vi.mock("./device-access", () => ({ getDeviceKey: () => "test-device" }));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(config: InternalAxiosRequestConfig, data = {}) {
  return { config, data, status: 200, statusText: "OK", headers: new AxiosHeaders() };
}
function failure(config: InternalAxiosRequestConfig, status = 401, data = {}) {
  return new AxiosError("Request failed", undefined, config, undefined, { ...response(config, data), status });
}

describe("API session fences", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearTokens();
    setTokens({ accessToken: "access-a", refreshToken: "refresh-a" });
  });

  it("keeps normal concurrent 401 refresh single-flight and replays each read once", async () => {
    const refresh = deferred<{ data: { accessToken: string } }>();
    const post = vi.spyOn(axios, "post").mockReturnValue(refresh.promise);
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      if (config.headers.Authorization === "Bearer access-a") throw failure(config);
      return response(config, { ok: true });
    });
    const first = API.get("/one", { adapter }), second = API.get("/two", { adapter });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    refresh.resolve({ data: { accessToken: "rotated-a" } });
    expect((await Promise.all([first, second])).every((result) => result.data.ok)).toBe(true);
    expect(adapter).toHaveBeenCalledTimes(4);
    expect(getAccessToken()).toBe("rotated-a");
    expect(getRefreshToken()).toBe("refresh-a");
  });

  it("binds dispatch to the session at invocation, before a same-tick login change", async () => {
    const seen: string[] = [];
    const request = API.post("/mutation", {}, { adapter: async (config) => { seen.push(String(config.headers.Authorization)); return response(config); } }).catch((error: unknown) => error);
    setTokens({ accessToken: "access-b", refreshToken: "refresh-b" });
    expect(await request).toMatchObject({ code: "ERR_CANCELED" });
    expect(seen).toEqual(["Bearer access-a"]);
  });

  it.each(["logout", "new-login"])("ignores old refresh success after %s", async (change) => {
    const refresh = deferred<{ data: { accessToken: string } }>();
    vi.spyOn(axios, "post").mockReturnValue(refresh.promise);
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => { throw failure(config); });
    const result = API.get("/private", { adapter }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    if (change === "logout") clearTokens();
    else setTokens({ accessToken: "access-b", refreshToken: "refresh-b" });
    refresh.resolve({ data: { accessToken: "obsolete-a" } });
    expect(await result).toMatchObject({ code: "ERR_CANCELED" });
    expect(getAccessToken()).toBe(change === "logout" ? null : "access-b");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 503])("old refresh failure %s cannot clear or restrict a newer session", async (status) => {
    const refresh = deferred<never>();
    vi.spyOn(axios, "post").mockReturnValue(refresh.promise);
    const invalidated = vi.fn(), restricted = vi.fn();
    window.addEventListener("auth-session-invalidated", invalidated);
    window.addEventListener("device-access-restricted", restricted);
    const result = API.get("/private", { adapter: async (config) => { throw failure(config); } }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    setTokens({ accessToken: "access-b", refreshToken: "refresh-b" });
    refresh.reject({ response: { status, data: { code: "DEVICE_REVOKED", authState: "revoked" } } });
    expect(await result).toMatchObject({ code: "ERR_CANCELED" });
    expect(getAccessToken()).toBe("access-b");
    expect(invalidated).not.toHaveBeenCalled(); expect(restricted).not.toHaveBeenCalled();
    window.removeEventListener("auth-session-invalidated", invalidated);
    window.removeEventListener("device-access-restricted", restricted);
  });

  it("does not let an old flight replace or clear a newer session's refresh flight", async () => {
    const old = deferred<{ data: { accessToken: string } }>(), current = deferred<{ data: { accessToken: string } }>();
    const post = vi.spyOn(axios, "post").mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const adapter = async (config: InternalAxiosRequestConfig) => {
      if (config.headers.Authorization !== "Bearer rotated-b") throw failure(config);
      return response(config);
    };
    const a = API.get("/a", { adapter }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    setTokens({ accessToken: "access-b", refreshToken: "refresh-b" });
    const b = API.get("/b", { adapter });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    old.resolve({ data: { accessToken: "obsolete-a" } });
    expect(await a).toMatchObject({ code: "ERR_CANCELED" });
    const b2 = API.get("/b2", { adapter });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(post).toHaveBeenCalledTimes(2);
    current.resolve({ data: { accessToken: "rotated-b" } });
    await Promise.all([b, b2]);
    expect(getAccessToken()).toBe("rotated-b");
  });

  it.each(["success", "device-error"])("rejects a late ordinary %s without accepting prior-account data", async (outcome) => {
    const gate = deferred<void>();
    const restricted = vi.fn(); window.addEventListener("device-access-restricted", restricted);
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      await gate.promise;
      if (outcome === "device-error") throw failure(config, 403, { code: "DEVICE_REVOKED", authState: "revoked" });
      return response(config, { private: "account-a" });
    });
    const result = API.get("/private", { adapter }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalled());
    setTokens({ accessToken: "access-b", refreshToken: "refresh-b" }); gate.resolve();
    expect(await result).toMatchObject({ code: "ERR_CANCELED" });
    expect(restricted).not.toHaveBeenCalled();
    window.removeEventListener("device-access-restricted", restricted);
  });

  it("keeps device restriction and explicit no-replay mutation gates", async () => {
    const post = vi.spyOn(axios, "post");
    const restricted = vi.fn(); window.addEventListener("device-access-restricted", restricted);
    await expect(API.get("/private", { adapter: async (config) => { throw failure(config, 403, { code: "DEVICE_PENDING", authState: "pending" }); } })).rejects.toBeInstanceOf(AxiosError);
    expect(restricted).toHaveBeenCalledTimes(1);
    await expect(API.post("/mutation", {}, { _retry: true, adapter: async (config) => { throw failure(config); } } as import("./api").RetriableAxiosConfig)).rejects.toBeInstanceOf(AxiosError);
    expect(post).not.toHaveBeenCalled();
    window.removeEventListener("device-access-restricted", restricted);
  });

  it.each([401, 503])("preserves existing terminal versus transient refresh failure behavior (%s)", async (status) => {
    vi.spyOn(axios, "post").mockRejectedValue({ response: { status, data: {} } });
    await expect(API.get("/private", { adapter: async (config) => { throw failure(config); } })).rejects.toMatchObject({ response: { status } });
    expect(getRefreshToken()).toBe(status === 401 ? null : "refresh-a");
  });
});
