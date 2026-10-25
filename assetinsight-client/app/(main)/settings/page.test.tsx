import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { advanceAuthSession, clearTokens, setTokens } from "@/lib/auth-storage";
import SettingsPage from "./page";

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  success: vi.fn(),
  user: { _id: "owner-a", email: "owner@example.test", username: "Example Owner", authProvider: "email" },
}));

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/lib/api", () => ({ default: { delete: mocks.remove } }));
vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => ({ user: mocks.user, logout: mocks.logout, refresh: mocks.refresh }) }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: mocks.success, error: vi.fn() } }));
vi.mock("@/components/user/UserAvatar", () => ({ UserAvatar: () => <span>Account avatar</span> }));
vi.mock("@/hooks/useOutlookCalendar", () => ({ useOutlookCalendar: () => ({ status: { connected: false, configured: false }, loading: false, busy: false, error: null, fetchStatus: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function openDelete() {
  fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
  return screen.getByRole("dialog", { name: "Delete account" });
}

function fillDelete(password = " exact password ") {
  const dialog = openDelete();
  fireEvent.change(within(dialog).getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
  const passwordInput = within(dialog).queryByLabelText("Password");
  if (passwordInput) fireEvent.change(passwordInput, { target: { value: password } });
  return dialog;
}

const receipt = { data: { message: "User account deleted successfully" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { _id: "owner-a", email: "owner@example.test", username: "Example Owner", authProvider: "email" };
  mocks.remove.mockReset().mockResolvedValue(receipt);
  mocks.logout.mockReset().mockImplementation(async () => { clearTokens(); });
  setTokens({ accessToken: "test-access-a", refreshToken: "test-refresh-a" });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});

describe("Settings account deletion", () => {
  it("requires exact DELETE and a password for email accounts without making requests", () => {
    render(<SettingsPage />);
    const dialog = openDelete();
    const button = within(dialog).getByRole("button", { name: "Permanently delete" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Type DELETE to confirm"), { target: { value: "delete" } });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "password" } });
    expect(button).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "" } });
    expect(button).toBeDisabled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Account and data-deletion instructions" })).toHaveAttribute("href", "/account-deletion");
    expect(within(dialog).getByText(/Reports, media and activity history/)).toHaveTextContent("separate");
  });

  it("preserves the exact password, prevents repeat submission and locks dismissal while pending", async () => {
    const request = deferred<typeof receipt>();
    mocks.remove.mockReturnValue(request.promise);
    render(<SettingsPage />);
    const dialog = fillDelete("  Mixed Case pass!  ");
    const button = within(dialog).getByRole("button", { name: "Permanently delete" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith("/user", { data: { password: "  Mixed Case pass!  " }, _retry: true, timeout: 30_000 });
    expect(within(dialog).getByRole("button", { name: "Deleting..." })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).getByLabelText("Password")).toBeDisabled();
    expect(within(dialog).getByLabelText("Type DELETE to confirm")).toBeDisabled();
    expect(fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }))).toBe(false);
    expect(dialog).toHaveAttribute("open");
    await act(async () => { request.resolve(receipt); });
    expect(mocks.logout).toHaveBeenCalledTimes(1);
  });

  it("supports a non-password account without inventing password data", async () => {
    mocks.user.authProvider = "google";
    render(<SettingsPage />);
    const dialog = fillDelete();
    expect(within(dialog).queryByLabelText("Password")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/welcome"));
    expect(mocks.remove).toHaveBeenCalledWith("/user", { data: undefined, _retry: true, timeout: 30_000 });
  });

  it("shows actionable password guidance, not a raw 401, and keeps input for correction", async () => {
    mocks.remove.mockRejectedValue({ message: "Request failed with status code 401", response: { status: 401, data: { message: "Invalid credentials" } } });
    render(<SettingsPage />);
    const dialog = fillDelete("mistyped password");
    fireEvent.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Your password or sign-in session could not be verified");
    expect(within(dialog).getByRole("alert")).not.toHaveTextContent("401");
    expect(within(dialog).getByLabelText("Password")).toHaveValue("mistyped password");
    expect(within(dialog).getByRole("button", { name: "Permanently delete" })).toBeEnabled();
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it.each([400, 403, 500])("never claims success for an HTTP %s error", async (status) => {
    mocks.remove.mockRejectedValue({ message: `Request failed with status code ${status}`, response: { status } });
    render(<SettingsPage />);
    const dialog = fillDelete();
    fireEvent.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    expect(await within(dialog).findByRole("alert")).not.toHaveTextContent(String(status));
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it.each([undefined, {}, { message: "ok" }, { message: "Processing" }])("rejects an unconfirmed or placeholder receipt: %j", async (data) => {
    mocks.remove.mockResolvedValue({ data });
    render(<SettingsPage />);
    const dialog = fillDelete();
    fireEvent.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Account deletion was not confirmed");
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("treats an interrupted request as uncertain and leaves confirmation details in place", async () => {
    mocks.remove.mockRejectedValue(new Error("Network Error"));
    render(<SettingsPage />);
    const dialog = fillDelete();
    fireEvent.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Contact support before trying again");
    expect(within(dialog).getByLabelText("Type DELETE to confirm")).toHaveValue("DELETE");
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("logs out only after an acknowledged deletion and does not relabel a logout failure as deletion failure", async () => {
    mocks.logout.mockImplementation(async () => { clearTokens(); throw new Error("Sign-out provider unavailable"); });
    render(<SettingsPage />);
    const dialog = fillDelete();
    fireEvent.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/welcome"));
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.success).toHaveBeenCalledWith("Account deleted. Associated report and media removal is a separate request.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(dialog).not.toHaveAttribute("open");
  });

  it.each(["owner", "session"])("does not start deletion after the %s changed while the dialog was open", (changed) => {
    const view = render(<SettingsPage />);
    const dialog = fillDelete();
    if (changed === "owner") { mocks.user = { ...mocks.user, _id: "owner-b" }; view.rerender(<SettingsPage />); }
    else advanceAuthSession();
    fireEvent.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Your account session changed");
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it.each(["owner", "session"])("does not sign out a changed %s after the old deletion response arrives", async (changed) => {
    const request = deferred<typeof receipt>();
    mocks.remove.mockReturnValue(request.promise);
    const view = render(<SettingsPage />);
    const dialog = fillDelete();
    fireEvent.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    if (changed === "owner") { mocks.user = { ...mocks.user, _id: "owner-b" }; view.rerender(<SettingsPage />); }
    else advanceAuthSession();
    await act(async () => { request.resolve(receipt); });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Your current account has not been signed out");
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("does not redirect a new session established while the logout request is settling", async () => {
    const signOut = deferred<void>();
    mocks.logout.mockImplementation(() => { clearTokens(); return signOut.promise; });
    render(<SettingsPage />);
    const dialog = fillDelete();
    fireEvent.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledOnce());
    setTokens({ accessToken: "test-access-b", refreshToken: "test-refresh-b" });
    await act(async () => { signOut.resolve(); });
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
