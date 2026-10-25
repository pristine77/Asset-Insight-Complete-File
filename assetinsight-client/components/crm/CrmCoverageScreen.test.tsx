import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/services/auth";
import { UserService } from "@/services/user";
import CrmCoverageScreen from "./CrmCoverageScreen";

vi.mock("@/services/user", () => ({ UserService: { getMe: vi.fn() } }));
vi.mock("./useCrmRead", () => ({ useCrmOnline: () => true }));
vi.mock("next/dynamic", () => ({ default: () => (props: { user: AuthUser; onClose: () => void; onSaved: (value: AuthUser) => void }) => <div role="dialog" aria-label="Edit coverage fixture"><p>{props.user.crmAddress}</p><button onClick={props.onClose}>Close editor</button><button onClick={() => props.onSaved({ ...props.user, crmAddress: "Canonical saved address" })}>Save editor</button></div> }));
const profile = { _id: "owner-a", email: "agent@example.test", isCrmAgent: true, crmAddress: "Current address", crmQuadrant: "NW,CENTRAL", crmSpecializations: ["others"] } as AuthUser;
beforeEach(() => { vi.mocked(UserService.getMe).mockResolvedValue(profile); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("standalone CRM coverage", () => {
  it("loads fresh owner profile with cancellation and a bounded read", async () => {
    render(<CrmCoverageScreen ownerId="owner-a" />);
    expect(await screen.findByText("Current address")).toBeInTheDocument();
    expect(UserService.getMe).toHaveBeenCalledWith({ signal: expect.any(AbortSignal), timeout: 20_000 });
    expect(screen.getByText("North West, Central")).toBeInTheDocument();
  });
  it("re-verifies before editing and after cancelled or uncertain saves", async () => {
    render(<CrmCoverageScreen ownerId="owner-a" />);
    await screen.findByText("Current address");
    vi.mocked(UserService.getMe).mockResolvedValueOnce({ ...profile, crmAddress: "Fresh before edit" });
    fireEvent.click(screen.getByRole("button", { name: "Edit coverage" }));
    await screen.findByRole("dialog");
    expect(screen.getAllByText("Fresh before edit")).toHaveLength(2);
    vi.mocked(UserService.getMe).mockResolvedValueOnce({ ...profile, crmAddress: "Committed despite lost save response" });
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(await screen.findByText("Committed despite lost save response")).toBeInTheDocument();
    expect(UserService.getMe).toHaveBeenCalledTimes(3);
  });
  it("adopts a canonical save response without refreshing auth or replaying a write", async () => {
    render(<CrmCoverageScreen ownerId="owner-a" />);
    await screen.findByText("Current address");
    fireEvent.click(screen.getByRole("button", { name: "Edit coverage" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Save editor" }));
    expect(screen.getByText("Canonical saved address")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Coverage saved");
    expect(UserService.getMe).toHaveBeenCalledTimes(2);
  });
  it("does not trust another owner or a revoked CRM profile", async () => {
    vi.mocked(UserService.getMe).mockResolvedValue({ ...profile, _id: "owner-b" });
    render(<CrmCoverageScreen ownerId="owner-a" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("CRM access is no longer available");
    expect(screen.queryByText("Current address")).not.toBeInTheDocument();
  });
  it("aborts and ignores a previous owner's delayed profile response", async () => {
    let resolve!: (value: AuthUser) => void;
    vi.mocked(UserService.getMe).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const view = render(<CrmCoverageScreen ownerId="owner-a" />);
    await waitFor(() => expect(UserService.getMe).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(UserService.getMe).mock.calls[0][0]?.signal;
    vi.mocked(UserService.getMe).mockResolvedValue({ ...profile, _id: "owner-b", crmAddress: "Second owner" });
    view.rerender(<CrmCoverageScreen ownerId="owner-b" />);
    expect(await screen.findByText("Second owner")).toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(profile));
    expect(screen.queryByText("Current address")).not.toBeInTheDocument();
  });
});
