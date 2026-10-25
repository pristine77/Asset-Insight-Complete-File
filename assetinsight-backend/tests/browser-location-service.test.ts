import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_LOCATION_MAX_PENDING_LOOKUPS,
  BROWSER_LOCATION_RATE_LIMIT_MAX_REQUESTS,
  BROWSER_LOCATION_RATE_LIMIT_WINDOW_MS,
  BrowserLocationCapacityError,
  BrowserLocationProviderError,
  BrowserLocationRequestAbortedError,
  consumeBrowserLocationRequestQuota,
  resetBrowserLocationServiceForTests,
  resolveBrowserLocation,
} from "../src/service/browserLocationService.js";

describe("browser location service", () => {
  beforeEach(() => {
    resetBrowserLocationServiceForTests();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a precise place name and matching currency from coordinates", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          display_name:
            "10 Downing Street, Westminster, London, England, SW1A 2AA, United Kingdom",
          address: { country_code: "gb" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await resolveBrowserLocation({
      latitude: 51.503407,
      longitude: -0.127592,
      acceptLanguage: "en-GB,en;q=0.9",
    });

    expect(result).toEqual({
      location:
        "10 Downing Street, Westminster, London, England, SW1A 2AA, United Kingdom",
      countryCode: "GB",
      currency: "GBP",
      source: "openstreetmap",
      attribution: "© OpenStreetMap contributors",
      attributionUrl: "https://www.openstreetmap.org/copyright",
    });
    const [url, options] = fetchMock.mock.calls[0];
    const requestUrl = new URL(String(url));
    expect(requestUrl.searchParams.get("lat")).toBe("51.503407");
    expect(requestUrl.searchParams.get("lon")).toBe("-0.127592");
    expect(requestUrl.searchParams.get("zoom")).toBe("18");
    expect(requestUrl.searchParams.get("addressdetails")).toBe("1");
    expect(requestUrl.searchParams.get("accept-language")).toBe("en");
    expect((options?.headers as Record<string, string>)["User-Agent"]).toContain(
      "AssetInsight"
    );
  });

  it("coalesces and caches duplicate coordinate lookups", async () => {
    const fetchMock = vi.mocked(fetch).mockImplementation(async () =>
      new Response(
        JSON.stringify({
          display_name: "Regina, Saskatchewan, Canada",
          address: { country_code: "ca" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const input = {
      latitude: 50.44521,
      longitude: -104.618896,
      acceptLanguage: "en-CA",
    };

    const [first, second] = await Promise.all([
      resolveBrowserLocation(input),
      resolveBrowserLocation(input),
    ]);
    const third = await resolveBrowserLocation(input);

    expect(first.location).toBe("Regina, Saskatchewan, Canada");
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects provider responses without a usable place name", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ address: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      resolveBrowserLocation({ latitude: 0, longitude: 0 })
    ).rejects.toBeInstanceOf(BrowserLocationProviderError);
  });

  it("classifies provider HTTP failures without exposing coordinates", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("busy", { status: 429 }));

    await expect(
      resolveBrowserLocation({ latitude: 51.5, longitude: -0.12 })
    ).rejects.toThrow("HTTP 429");
  });

  it("bounds unique pending provider work and still coalesces duplicates", async () => {
    const fetchMock = vi.mocked(fetch).mockImplementation(async () =>
      new Response(
        JSON.stringify({
          display_name: "Regina, Saskatchewan, Canada",
          address: { country_code: "ca" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const pending = Array.from(
      { length: BROWSER_LOCATION_MAX_PENDING_LOOKUPS },
      (_, index) =>
        resolveBrowserLocation({
          latitude: 50 + index / 100,
          longitude: -104,
        })
    );

    const duplicate = resolveBrowserLocation({ latitude: 50, longitude: -104 });
    await expect(
      resolveBrowserLocation({ latitude: 60, longitude: -110 })
    ).rejects.toBeInstanceOf(BrowserLocationCapacityError);
    await expect(Promise.all([...pending, duplicate])).resolves.toHaveLength(
      BROWSER_LOCATION_MAX_PENDING_LOOKUPS + 1
    );
    expect(fetchMock).toHaveBeenCalledTimes(
      BROWSER_LOCATION_MAX_PENDING_LOOKUPS
    );
  });

  it("removes a disconnected queued lookup before provider work begins", async () => {
    let finishFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      finishFirst = resolve;
    });
    const fetchMock = vi
      .mocked(fetch)
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            display_name: "Regina, Saskatchewan, Canada",
            address: { country_code: "ca" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    const first = resolveBrowserLocation({ latitude: 50, longitude: -104 });
    const controller = new AbortController();
    const cancelled = resolveBrowserLocation({
      latitude: 51,
      longitude: -105,
      signal: controller.signal,
    });

    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(
      BrowserLocationRequestAbortedError
    );
    finishFirst(
      new Response(
        JSON.stringify({
          display_name: "Regina, Saskatchewan, Canada",
          address: { country_code: "ca" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await expect(first).resolves.toMatchObject({ countryCode: "CA" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a coalesced lookup alive while another subscriber remains", async () => {
    let finishLookup!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finishLookup = resolve;
      })
    );
    const controller = new AbortController();
    const cancelled = resolveBrowserLocation({
      latitude: 50.44521,
      longitude: -104.618896,
      signal: controller.signal,
    });
    const remaining = resolveBrowserLocation({
      latitude: 50.44521,
      longitude: -104.618896,
    });

    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(
      BrowserLocationRequestAbortedError
    );
    finishLookup(
      new Response(
        JSON.stringify({
          display_name: "Regina, Saskatchewan, Canada",
          address: { country_code: "ca" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await expect(remaining).resolves.toMatchObject({ countryCode: "CA" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("limits each caller independently and allows requests after the window", () => {
    const now = 1_000_000;
    for (
      let attempt = 0;
      attempt < BROWSER_LOCATION_RATE_LIMIT_MAX_REQUESTS;
      attempt += 1
    ) {
      expect(consumeBrowserLocationRequestQuota("user:a", now)).toMatchObject({
        allowed: true,
        remaining: BROWSER_LOCATION_RATE_LIMIT_MAX_REQUESTS - attempt - 1,
      });
    }
    expect(consumeBrowserLocationRequestQuota("user:a", now)).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: BROWSER_LOCATION_RATE_LIMIT_WINDOW_MS / 1_000,
    });
    expect(consumeBrowserLocationRequestQuota("user:b", now)).toMatchObject({
      allowed: true,
    });
    expect(
      consumeBrowserLocationRequestQuota(
        "user:a",
        now + BROWSER_LOCATION_RATE_LIMIT_WINDOW_MS
      )
    ).toMatchObject({ allowed: true });
  });
});
