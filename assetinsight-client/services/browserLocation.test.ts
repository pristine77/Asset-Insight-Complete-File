import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "@/lib/api";
import { BrowserLocationService } from "./browserLocation";

vi.mock("@/lib/api", () => ({
  default: { post: vi.fn() },
}));

const apiPost = vi.mocked(API.post);

describe("BrowserLocationService", () => {
  beforeEach(() => {
    apiPost.mockReset();
  });

  it("uses the authenticated API client and unwraps the backend envelope", async () => {
    const controller = new AbortController();
    apiPost.mockResolvedValue({
      data: {
        message: "Location resolved",
        data: {
          location: "10 Downing Street, London SW1A 2AA, United Kingdom",
          currency: "gbp",
          attribution: "© OpenStreetMap contributors",
          attributionUrl: "https://www.openstreetmap.org/copyright",
          source: "nominatim",
        },
      },
    } as never);

    await expect(
      BrowserLocationService.reverseGeocode(
        { latitude: 51.507351, longitude: -0.127758 },
        { signal: controller.signal }
      )
    ).resolves.toEqual({
      location: "10 Downing Street, London SW1A 2AA, United Kingdom",
      currency: "GBP",
      attribution: "© OpenStreetMap contributors",
      attributionUrl: "https://www.openstreetmap.org/copyright",
      source: "nominatim",
    });
    expect(apiPost).toHaveBeenCalledWith(
      "/location/reverse-geocode",
      { latitude: 51.507351, longitude: -0.127758 },
      { signal: controller.signal }
    );
  });

  it("also accepts a direct validated payload", async () => {
    apiPost.mockResolvedValue({
      data: { location: "Regina, Saskatchewan, Canada" },
    } as never);

    await expect(
      BrowserLocationService.reverseGeocode({
        latitude: 50.4452,
        longitude: -104.6189,
      })
    ).resolves.toEqual({ location: "Regina, Saskatchewan, Canada" });
  });

  it.each([
    { data: {} },
    { data: { location: "Lat 51.507351 / Long -0.127758" } },
    { data: { location: "London", currency: "pounds" } },
    { data: { location: "London", attributionUrl: "javascript:alert(1)" } },
  ])("rejects malformed provider responses", async (data) => {
    apiPost.mockResolvedValue({ data } as never);
    await expect(
      BrowserLocationService.reverseGeocode({
        latitude: 51.507351,
        longitude: -0.127758,
      })
    ).rejects.toThrow();
  });

  it("rejects invalid coordinates before making a request", async () => {
    await expect(
      BrowserLocationService.reverseGeocode({ latitude: 91, longitude: 0 })
    ).rejects.toThrow("Valid latitude and longitude are required");
    expect(apiPost).not.toHaveBeenCalled();
  });
});
