import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkspacePicker from "./WorkspacePicker";

const mocks = vi.hoisted(() => ({ replace: vi.fn(), logout: vi.fn(), toggleMode: vi.fn(), user: { _id: "owner", username: "Assigned agent", isCrmAgent: true as unknown }, loading: false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("next/link", () => ({ default: ({ children, prefetch: _prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => <a {...props}>{children}</a> }));
vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => ({ user: mocks.user, loading: mocks.loading, loggingOut: false, logout: mocks.logout }) }));
vi.mock("@/components/providers/ColorModeProvider", () => ({ useColorMode: () => ({ resolvedTheme: "light", toggleMode: mocks.toggleMode }) }));
beforeEach(() => { vi.clearAllMocks(); mocks.user = { _id: "owner", username: "Assigned agent", isCrmAgent: true }; mocks.loading = false; });
describe("workspace picker", () => {
  it("offers both explicit workspaces only for enabled agents", () => {
    render(<WorkspacePicker />);
    expect(screen.getByRole("link", { name: "Open CRM" })).toHaveAttribute("href", "/crm");
    expect(screen.getByRole("link", { name: "Open Listings" })).toHaveAttribute("href", "/dashboard");
    expect(mocks.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use dark theme" })); expect(mocks.toggleMode).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" })); expect(mocks.logout).toHaveBeenCalledOnce();
  });
  it.each([false, undefined, "true"])("cannot grant access from a non-true flag %s", (flag) => {
    mocks.user.isCrmAgent = flag; render(<WorkspacePicker />);
    expect(screen.queryByRole("link", { name: "Open CRM" })).not.toBeInTheDocument();
    expect(mocks.replace).toHaveBeenCalledWith("/dashboard");
  });
  it("waits for current identity before redirecting", () => {
    mocks.loading = true; mocks.user.isCrmAgent = false; render(<WorkspacePicker />);
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
