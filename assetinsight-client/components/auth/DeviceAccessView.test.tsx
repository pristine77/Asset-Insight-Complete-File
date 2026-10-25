import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DeviceAccessView from "./DeviceAccessView";
import { useAuthContext } from "@/context/AuthContext";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("next/image", () => ({
  default: () => null,
}));

vi.mock("@/context/AuthContext", () => ({
  useAuthContext: vi.fn(),
}));

vi.mock("@/components/auth/ThemeToggle", () => ({
  default: () => null,
}));

vi.mock("@/lib/device-access", () => ({
  buildBasicDeviceContext: vi.fn(() => new Promise(() => undefined)),
  CameraVerificationError: class CameraVerificationError extends Error {},
}));

const base = {
  user: null,
  sessionPresent: false,
  loading: false,
  error: null,
  loggingOut: false,
  refresh: vi.fn(),
  login: vi.fn(),
  acceptAuthResponse: vi.fn(),
  registerDevice: vi.fn(),
  refreshDeviceStatus: vi.fn(),
  rerequestDevice: vi.fn(),
  logout: vi.fn(),
};

describe("DeviceAccessView", () => {
  beforeEach(() => {
    replace.mockReset();
  });

  it("renders a pending request without redirecting away", () => {
    vi.mocked(useAuthContext).mockReturnValue({
      ...base,
      deviceAccess: {
        authState: "pending",
        challengeToken: "challenge",
        device: { id: "device-1", status: "pending", displayName: "Chrome" },
      },
    });

    render(<DeviceAccessView />);

    expect(screen.getByRole("heading", { name: /waiting for administrator approval/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check status now/i })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows a rejection reason, support details, and re-request action", () => {
    vi.mocked(useAuthContext).mockReturnValue({
      ...base,
      deviceAccess: {
        authState: "rejected",
        reason: "Unrecognized installation",
        supportContact: {
          name: "Security team",
          email: "security@example.test",
          phone: "+44 20 7946 0000",
        },
      },
    });

    render(<DeviceAccessView />);

    expect(screen.getByText("Unrecognized installation")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "security@example.test" })).toHaveAttribute(
      "href",
      "mailto:security@example.test"
    );
    expect(screen.getByRole("button", { name: /request again/i })).toBeInTheDocument();
  });

  it("does not offer a re-request when the IP is blocked", () => {
    vi.mocked(useAuthContext).mockReturnValue({
      ...base,
      deviceAccess: {
        authState: "ip_blocked",
        supportContact: {
          name: "Security team",
          email: "security@example.test",
          phone: "+44 20 7946 0000",
        },
      },
    });

    render(<DeviceAccessView />);

    expect(screen.getByRole("heading", { name: /this ip address is blocked/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /request again/i })).not.toBeInTheDocument();
  });
});
