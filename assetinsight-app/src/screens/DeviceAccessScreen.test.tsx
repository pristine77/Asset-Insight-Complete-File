import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import DeviceAccessScreen from "./DeviceAccessScreen";
import { useAuth } from "../context/AuthContext";

jest.mock("../context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));
jest.mock("../services/deviceMetadataService", () => ({
  buildNativeDeviceContext: jest.fn(() => new Promise(() => undefined)),
  NativeCameraVerificationError: class NativeCameraVerificationError extends Error {},
}));

const base = {
  user: null,
  loading: false,
  isAuthenticated: false,
  login: jest.fn(),
  registerDevice: jest.fn(),
  refreshDeviceStatus: jest.fn(),
  rerequestDevice: jest.fn(),
  logout: jest.fn(),
  refreshUser: jest.fn(),
  error: null,
  clearError: jest.fn(),
};

describe("DeviceAccessScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the native pending state and manual status action", async () => {
    jest.mocked(useAuth).mockReturnValue({
      ...base,
      deviceAccess: {
        authState: "pending",
        challengeToken: "challenge",
        device: { id: "device-1", status: "pending", displayName: "Android tablet" },
      },
    });

    await render(<DeviceAccessScreen />);

    expect(screen.getByText("Waiting for approval")).toBeTruthy();
    expect(screen.getByText("Check status")).toBeTruthy();
  });

  it("shows support but no re-request action for a blocked IP", async () => {
    jest.mocked(useAuth).mockReturnValue({
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

    await render(<DeviceAccessScreen />);

    expect(screen.getByText("IP address blocked")).toBeTruthy();
    expect(screen.getByText("security@example.test")).toBeTruthy();
    expect(screen.queryByText("Request again")).toBeNull();
  });

  it("uses the polished primary action for a rejected device and submits a re-request", async () => {
    const rerequestDevice = jest.fn().mockResolvedValue(undefined);
    jest.mocked(useAuth).mockReturnValue({
      ...base,
      rerequestDevice,
      deviceAccess: {
        authState: "rejected",
        reason: "Confirm this managed phone.",
        device: { id: "device-2", status: "rejected", displayName: "Samsung Galaxy S22+" },
      },
    });

    const rendered = await render(<DeviceAccessScreen />);
    const action = rendered.getByRole("button", { name: "Request again" });
    expect(action.props.accessibilityState).toMatchObject({ disabled: false, busy: false });
    fireEvent.press(action);
    expect(rerequestDevice).toHaveBeenCalledTimes(1);
  });
});
