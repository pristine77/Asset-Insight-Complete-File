import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  store: vi.fn(),
  current: {
    authState: "pending",
    challengeToken: "status-challenge",
    challengeExpiresAt: "2026-07-22T00:00:00.000Z",
  } as Record<string, unknown>,
}));

vi.mock("@/lib/api", () => ({
  default: { get: mocks.get, post: mocks.post },
}));

vi.mock("@/lib/device-access", () => ({
  clearStoredDeviceAccess: vi.fn(),
  collectVerifiedDeviceContext: vi.fn(),
  getDeviceKey: () => "installation-key",
  getStoredDeviceAccess: () => mocks.current,
  storeDeviceAccess: mocks.store,
}));

vi.mock("@/lib/auth-storage", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/auth-storage")>(), setTokens: vi.fn() }));

import { DeviceAccessService } from "./device-access";

describe("DeviceAccessService status", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.store.mockReset();
  });

  it("retains the status challenge when a pending poll omits it", async () => {
    mocks.get.mockResolvedValue({
      data: {
        status: "pending",
        code: "DEVICE_PENDING",
        device: { id: "device-1", status: "pending" },
      },
    });

    const result = await DeviceAccessService.status();

    expect(result.challengeToken).toBe("status-challenge");
    expect(result.challengeExpiresAt).toBe("2026-07-22T00:00:00.000Z");
    expect(mocks.store).toHaveBeenCalledWith(
      expect.objectContaining({
        authState: "pending",
        challengeToken: "status-challenge",
      })
    );
  });
});
