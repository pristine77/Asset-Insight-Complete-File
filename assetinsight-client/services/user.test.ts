import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import API, { type RetriableAxiosConfig } from "@/lib/api";
import { getAccessToken, setTokens } from "@/lib/auth-storage";
import { UserService } from "./user";

vi.mock("@/lib/device-access", () => ({ getDeviceKey: () => "test-installation" }));

const originalAdapter = API.defaults.adapter;
const adapter = vi.fn<(config: InternalAxiosRequestConfig) => Promise<AxiosResponse>>();

beforeEach(() => {
  adapter.mockReset();
  API.defaults.adapter = adapter;
  setTokens({ accessToken: "test-access", refreshToken: "test-refresh" });
  vi.spyOn(axios, "post").mockRejectedValue(new Error("Unexpected external request blocked by test"));
});
afterEach(() => { API.defaults.adapter = originalAdapter; });

function respond(data: unknown) {
  adapter.mockImplementation(async (config) => ({ config, data, status: 200, statusText: "OK", headers: {} }));
}

describe("UserService deleteAccount", () => {
  it.each(["  Exact password!  ", "", undefined])("uses one bounded no-replay request with the exact optional password (%j)", async (password) => {
    respond({ message: "User account deleted successfully" });
    await expect(UserService.deleteAccount(password)).resolves.toEqual({ message: "User account deleted successfully" });
    expect(adapter).toHaveBeenCalledTimes(1);
    const request = adapter.mock.calls[0][0] as InternalAxiosRequestConfig & RetriableAxiosConfig;
    expect(request.url).toBe("/user");
    expect(request.method).toBe("delete");
    expect(request._retry).toBe(true);
    expect(request.timeout).toBe(30_000);
    expect(request.data).toBe(password === undefined ? undefined : JSON.stringify({ password }));
  });

  it("never refreshes or replays a wrong-password 401 and preserves the current session", async () => {
    adapter.mockImplementation(async (config) => {
      throw new AxiosError("Request failed with status code 401", "ERR_BAD_REQUEST", config, undefined, { config, data: { message: "Invalid credentials" }, status: 401, statusText: "Unauthorized", headers: {} });
    });
    await expect(UserService.deleteAccount("wrong-password")).rejects.toMatchObject({ response: { status: 401 } });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe("test-access");
  });

  it.each([undefined, null, {}, { message: "" }, { message: "ok" }, { message: "Processing" }, { success: true }, { message: "User account deleted successfully " }])("rejects an unconfirmed response %j", async (data) => {
    respond(data);
    await expect(UserService.deleteAccount("password")).rejects.toThrow("Account deletion was not confirmed");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("does not replay network failures", async () => {
    adapter.mockImplementation(async (config) => { throw new AxiosError("Network Error", "ERR_NETWORK", config); });
    await expect(UserService.deleteAccount("password")).rejects.toMatchObject({ code: "ERR_NETWORK" });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
