import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProtectedRoute from "./ProtectedRoute";
const mocks = vi.hoisted(() => ({ replace: vi.fn(), state: { user: null as unknown, loading: false, loggingOut: false, sessionPresent: false, deviceAccess: null as unknown } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/crm/tasks", useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => mocks.state }));
beforeEach(() => { vi.clearAllMocks(); mocks.state = { user: null, loading: false, loggingOut: false, sessionPresent: false, deviceAccess: null }; window.history.replaceState({}, "", "/crm/tasks?task=abc"); });
describe("authenticated workspace boundary", () => {
  it("holds children while identity loads, not only while cookies are absent", () => {
    mocks.state.loading = true; mocks.state.sessionPresent = true;
    render(<ProtectedRoute>Private data</ProtectedRoute>);
    expect(screen.queryByText("Private data")).not.toBeInTheDocument(); expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("preserves the query through login", () => {
    render(<ProtectedRoute>Private data</ProtectedRoute>);
    expect(mocks.replace).toHaveBeenCalledWith("/login?next=%2Fcrm%2Ftasks%3Ftask%3Dabc");
    expect(screen.queryByText("Private data")).not.toBeInTheDocument();
  });
  it("preserves the query through device approval", () => {
    mocks.state.deviceAccess = { authState: "pending" }; render(<ProtectedRoute>Private data</ProtectedRoute>);
    expect(mocks.replace).toHaveBeenCalledWith("/device-access?next=%2Fcrm%2Ftasks%3Ftask%3Dabc");
  });
  it("reveals only authenticated children and unmounts them while logging out", () => {
    mocks.state.user = { _id: "owner" }; const view = render(<ProtectedRoute>Private data</ProtectedRoute>);
    expect(screen.getByText("Private data")).toBeVisible(); mocks.state.loggingOut = true; view.rerender(<ProtectedRoute>Private data</ProtectedRoute>);
    expect(screen.queryByText("Private data")).not.toBeInTheDocument();
  });
});
