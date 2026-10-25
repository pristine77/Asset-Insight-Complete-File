import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuthContext, type AuthContextType } from "./AuthContext";
import { clearTokens, getRefreshToken, setTokens } from "@/lib/auth-storage";
import { clearStoredDeviceAccess } from "@/lib/device-access";
import type { AuthenticatedResponse, AuthUser } from "@/services/auth";
import ProtectedRoute from "@/components/auth/ProtectedRoute";

const mocks = vi.hoisted(() => ({ getMe: vi.fn(), login: vi.fn(), logout: vi.fn(), status: vi.fn(), exchange: vi.fn(), register: vi.fn(), rerequest: vi.fn(), replace: vi.fn() }));
vi.mock("@/services/user", () => ({ UserService: { getMe: mocks.getMe } }));
vi.mock("@/services/auth", () => ({ AuthService: { login: mocks.login, logout: mocks.logout } }));
vi.mock("@/services/device-access", () => ({ DeviceAccessService: { status: mocks.status, exchange: mocks.exchange, register: mocks.register, rerequest: mocks.rerequest } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }), usePathname: () => "/workspaces" }));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const a: AuthUser = { _id: "owner-a", email: "a@example.test", isCrmAgent: true };
const b: AuthUser = { _id: "owner-b", email: "b@example.test", isCrmAgent: true };
const loginResponse = (user = b): AuthenticatedResponse => ({ authState: "authenticated", user, accessToken: "access-b", refreshToken: "refresh-b" });
let auth: AuthContextType;
function Probe() {
  const current = useAuthContext();
  useLayoutEffect(() => { auth = current; }, [current]);
  return <><span data-testid="owner">{current.user?._id || "none"}</span><span data-testid="loading">{String(current.loading)}</span><span data-testid="logout">{String(current.loggingOut)}</span><span data-testid="device">{current.deviceAccess?.authState || "none"}</span><ProtectedRoute>Private workspace</ProtectedRoute></>;
}

describe("AuthContext session ordering", () => {
  beforeEach(() => {
    vi.resetAllMocks(); clearTokens(); clearStoredDeviceAccess(); window.history.replaceState({}, "", "/workspaces");
    setTokens({ accessToken: "access-a", refreshToken: "refresh-a" });
    mocks.getMe.mockResolvedValue(a);
    mocks.logout.mockImplementation(async () => { clearTokens(); clearStoredDeviceAccess(); });
    mocks.login.mockImplementation(async () => { const result = loginResponse(); setTokens(result); return result; });
  });

  it("finishes logout, hides private children immediately and allows the sign-in redirect", async () => {
    const receipt = deferred<void>(); mocks.logout.mockImplementation(async () => { clearTokens(); await receipt.promise; });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("Private workspace")).toBeVisible());
    let logout!: Promise<void>; act(() => { logout = auth.logout(); });
    expect(screen.queryByText("Private workspace")).not.toBeInTheDocument(); expect(auth.loggingOut).toBe(true);
    await act(async () => { receipt.resolve(); await logout; });
    expect(auth.user).toBeNull(); expect(auth.loggingOut).toBe(false); expect(auth.sessionPresent).toBe(false);
    expect(mocks.replace).toHaveBeenCalledWith("/login?next=%2Fworkspaces");
  });

  it.each(["resolve", "reject"])("old getMe %s cannot restore/clear identity after logout and a new login", async (outcome) => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user).toEqual(a));
    const old = deferred<AuthUser>(); mocks.getMe.mockReturnValueOnce(old.promise);
    let refresh!: Promise<void>; act(() => { refresh = auth.refresh(); });
    await act(async () => { await auth.logout(); await auth.login({ email: b.email, password: "fixture" }); });
    expect(auth.user).toEqual(b);
    await act(async () => { if (outcome === "resolve") old.resolve(a); else old.reject(new Error("old failure")); await refresh; });
    expect(auth.user).toEqual(b); expect(getRefreshToken()).toBe("refresh-b"); expect(auth.loggingOut).toBe(false);
  });

  it("a late refresh cannot restore a user after logout without a later login", async () => {
    render(<AuthProvider><Probe /></AuthProvider>); await waitFor(() => expect(auth.user).toEqual(a));
    const old = deferred<AuthUser>(); mocks.getMe.mockReturnValueOnce(old.promise);
    let refresh!: Promise<void>; act(() => { refresh = auth.refresh(); });
    await act(async () => { await auth.logout(); old.resolve(a); await refresh; });
    expect(auth.user).toBeNull(); expect(auth.sessionPresent).toBe(false); expect(getRefreshToken()).toBeNull();
  });

  it.each(["device-access-restricted", "auth-session-invalidated"])("late refresh cannot defeat %s", async (event) => {
    render(<AuthProvider><Probe /></AuthProvider>); await waitFor(() => expect(auth.user).toEqual(a));
    const old = deferred<AuthUser>(); mocks.getMe.mockReturnValueOnce(old.promise);
    let refresh!: Promise<void>; act(() => { refresh = auth.refresh(); });
    act(() => window.dispatchEvent(new CustomEvent(event, { detail: { authState: "revoked", code: "DEVICE_REVOKED" } })));
    await act(async () => { old.resolve(a); await refresh; });
    expect(auth.user).toBeNull(); expect(auth.sessionPresent).toBe(false); expect(getRefreshToken()).toBeNull();
    if (event === "device-access-restricted") expect(auth.deviceAccess?.authState).toBe("revoked");
  });

  it("an old logout completion does not clear a newer login's identity", async () => {
    const receipt = deferred<void>(); mocks.logout.mockImplementation(async () => { clearTokens(); await receipt.promise; });
    render(<AuthProvider><Probe /></AuthProvider>); await waitFor(() => expect(auth.user).toEqual(a));
    let logout!: Promise<void>; act(() => { logout = auth.logout(); });
    await act(async () => { await auth.login({ email: b.email, password: "fixture" }); receipt.resolve(); await logout; });
    expect(auth.user).toEqual(b); expect(auth.loggingOut).toBe(false); expect(getRefreshToken()).toBe("refresh-b");
  });

  it("only the latest refresh applies, including StrictMode bootstrap", async () => {
    const old = deferred<AuthUser>(); mocks.getMe.mockReturnValueOnce(old.promise).mockResolvedValueOnce(b);
    render(<StrictMode><AuthProvider><Probe /></AuthProvider></StrictMode>);
    await waitFor(() => expect(auth.user).toEqual(b));
    await act(async () => { old.resolve(a); await old.promise; });
    expect(auth.user).toEqual(b); expect(auth.loading).toBe(false);
  });

  it("does not adopt an old response after storage changes outside the provider", async () => {
    const old = deferred<AuthUser>(); mocks.getMe.mockReturnValueOnce(old.promise);
    render(<AuthProvider><Probe /></AuthProvider>);
    setTokens({ accessToken: "access-b", refreshToken: "refresh-b" });
    await act(async () => { old.resolve(a); await old.promise; });
    expect(auth.user).toBeNull(); expect(getRefreshToken()).toBe("refresh-b");
  });

  it("coalesces device status but ignores a late approved status after logout", async () => {
    render(<AuthProvider><Probe /></AuthProvider>); await waitFor(() => expect(auth.user).toEqual(a));
    const old = deferred<{ authState: string; status: string }>(); mocks.status.mockReturnValueOnce(old.promise);
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { first = auth.refreshDeviceStatus(); second = auth.refreshDeviceStatus(); });
    expect(first).toBe(second); const result = first.catch((error: unknown) => error);
    await act(async () => { await auth.logout(); old.resolve({ authState: "approved", status: "approved" }); await result; });
    expect(await result).toMatchObject({ code: "ERR_CANCELED" }); expect(mocks.exchange).not.toHaveBeenCalled(); expect(auth.user).toBeNull();
  });

  it("background refresh/status cannot supersede a pending login's identity commit", async () => {
    render(<AuthProvider><Probe /></AuthProvider>); await waitFor(() => expect(auth.user).toEqual(a));
    const gate = deferred<void>(); mocks.login.mockImplementation(async () => { await gate.promise; const result = loginResponse(); setTokens(result); return result; });
    let login!: ReturnType<AuthContextType["login"]>;
    act(() => { login = auth.login({ email: b.email, password: "fixture" }); });
    await act(async () => { await auth.refresh(); await auth.refreshDeviceStatus(); });
    expect(mocks.getMe).toHaveBeenCalledTimes(1); expect(mocks.status).not.toHaveBeenCalled();
    await act(async () => { gate.resolve(); await login; });
    expect(auth.user).toEqual(b); expect(getRefreshToken()).toBe("refresh-b");
    mocks.getMe.mockResolvedValue(b); await act(async () => { await auth.refresh(); });
    expect(mocks.getMe).toHaveBeenCalledTimes(2);
  });

  it("background refresh cannot supersede an approved device exchange", async () => {
    render(<AuthProvider><Probe /></AuthProvider>); await waitFor(() => expect(auth.user).toEqual(a));
    const gate = deferred<void>(); mocks.status.mockResolvedValue({ authState: "approved", status: "approved" });
    mocks.exchange.mockImplementation(async () => { await gate.promise; const result = loginResponse(); setTokens(result); return result; });
    let status!: Promise<void>; act(() => { status = auth.refreshDeviceStatus(); });
    await waitFor(() => expect(mocks.exchange).toHaveBeenCalledTimes(1));
    await act(async () => { await auth.refresh(); });
    expect(mocks.getMe).toHaveBeenCalledTimes(1);
    await act(async () => { gate.resolve(); await status; });
    expect(auth.user).toEqual(b); expect(getRefreshToken()).toBe("refresh-b");
  });
});
