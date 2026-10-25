import { beforeEach, describe, expect, it } from "vitest";
import { captureAuthSession, clearTokens, isAuthSessionCurrent, REFRESH_KEY, setAccessToken, setTokens } from "./auth-storage";

describe("auth session snapshots", () => {
  beforeEach(() => clearTokens());
  it("allows token rotation but rejects logout and a new login reusing identical token values", () => {
    setTokens({ accessToken: "access", refreshToken: "refresh" });
    const original = captureAuthSession(); setAccessToken("rotated");
    expect(isAuthSessionCurrent(original)).toBe(true);
    clearTokens(); setTokens({ accessToken: "access", refreshToken: "refresh" });
    expect(isAuthSessionCurrent(original)).toBe(false);
  });
  it("also detects another tab replacing the refresh token", () => {
    setTokens({ accessToken: "access", refreshToken: "refresh" });
    const original = captureAuthSession(); localStorage.setItem(REFRESH_KEY, "another-session");
    expect(isAuthSessionCurrent(original)).toBe(false);
  });
});
