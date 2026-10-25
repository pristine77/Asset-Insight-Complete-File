import { describe, expect, it } from "vitest";
import {
  applyManualPreviewLocation,
  applyResolvedPreviewLocation,
  FRESH_HIGH_ACCURACY_POSITION_OPTIONS,
  formatBrowserAccuracyStatus,
  formatBrowserCoordinates,
  formatBrowserLocationAttribution,
  hasUsableReportLocation,
  isCoordinateOnlyReportLocation,
  isValidBrowserCoordinates,
  normalizePreviewLocationData,
  parseBrowserCoordinateLocation,
} from "./browserLocation";

describe("browser location helpers", () => {
  it.each([
    [null, null],
    [undefined, undefined],
    ["", ""],
    ["   ", "   "],
    [Number.NaN, 0],
    [0, Number.POSITIVE_INFINITY],
    [91, 0],
    [-91, 0],
    [0, 181],
    [0, -181],
  ])("rejects invalid coordinates %p, %p", (latitude, longitude) => {
    expect(isValidBrowserCoordinates(latitude, longitude)).toBe(false);
  });

  it("accepts zero and valid numeric strings without coercing blank values", () => {
    expect(isValidBrowserCoordinates(0, 0)).toBe(true);
    expect(isValidBrowserCoordinates("0", "0")).toBe(true);
    expect(isValidBrowserCoordinates("51.507351", "-0.127758")).toBe(true);
  });

  it("formats coordinates to six decimal places", () => {
    expect(formatBrowserCoordinates(51.5073509, -0.1277584)).toBe(
      "Lat 51.507351 / Long -0.127758"
    );
    expect(formatBrowserCoordinates(null, null)).toBe(
      "Latitude/Longitude not detected"
    );
  });

  it.each([
    null,
    undefined,
    "",
    "   ",
    "Current Browser Location",
    " current browser location ",
    "CURRENT BROWSER LOCATION",
    "Lat 51.507351 / Long -0.127758",
    "Latitude 51.507351, Longitude -0.127758",
    "Lat 999 / Long 999",
  ])("rejects unusable report location %p", (location) => {
    expect(hasUsableReportLocation(location)).toBe(false);
  });

  it("accepts readable report locations", () => {
    expect(hasUsableReportLocation("10 Downing Street, London")).toBe(true);
  });

  it("recognizes and parses legacy coordinate-only labels", () => {
    expect(
      parseBrowserCoordinateLocation("Lat 51.507351 / Long -0.127758")
    ).toEqual({ latitude: 51.507351, longitude: -0.127758 });
    expect(
      parseBrowserCoordinateLocation("Latitude 50.1, Longitude -104.2")
    ).toEqual({ latitude: 50.1, longitude: -104.2 });
    expect(isCoordinateOnlyReportLocation("Warehouse 51, London")).toBe(false);
    expect(
      parseBrowserCoordinateLocation("Lat 95 / Long -0.127758")
    ).toBeNull();
  });

  it("always includes OpenStreetMap attribution for resolved locations", () => {
    expect(formatBrowserLocationAttribution(undefined)).toBe(
      "© OpenStreetMap contributors"
    );
    expect(
      formatBrowserLocationAttribution("Address data © OpenStreetMap contributors")
    ).toBe("Address data © OpenStreetMap contributors");
    expect(formatBrowserLocationAttribution("Provider terms apply")).toBe(
      "© OpenStreetMap contributors · Provider terms apply"
    );
  });

  it("provides an honest accuracy status", () => {
    expect(formatBrowserAccuracyStatus(7.6)).toBe(
      "Accurate to within approximately 8 m"
    );
    expect(formatBrowserAccuracyStatus(0)).toBe(
      "Accurate to within approximately 1 m"
    );
    expect(formatBrowserAccuracyStatus(null)).toBe(
      "Location accuracy unavailable"
    );
  });

  it("requires a fresh high-accuracy browser position", () => {
    expect(FRESH_HIGH_ACCURACY_POSITION_OPTIONS).toEqual({
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 0,
    });
    expect(Object.isFrozen(FRESH_HIGH_ACCURACY_POSITION_OPTIONS)).toBe(true);
  });

  it("preserves a readable preview location with its valid coordinate pair", () => {
    expect(
      normalizePreviewLocationData({
        location: "10 Downing Street, London",
        latitude: 51.503407,
        longitude: -0.127592,
        lots: [],
      })
    ).toMatchObject({
      location: "10 Downing Street, London",
      latitude: 51.503407,
      longitude: -0.127592,
    });
  });

  it("keeps legacy coordinates hidden until a readable name is resolved", () => {
    const normalized = normalizePreviewLocationData({
      location: "Lat 51.503407 / Long -0.127592",
      latitude: null,
      longitude: null,
      lots: [],
    });

    expect(normalized.location).toBe("");
    expect(normalized).toMatchObject({
      latitude: 51.503407,
      longitude: -0.127592,
    });
    expect(JSON.stringify(normalized)).not.toContain("Current Browser Location");
  });

  it.each([
    {
      label: "explicit root coordinate fields",
      input: {
        location: "Current Browser Location",
        latitude: 51.503407,
        longitude: -0.127592,
      },
    },
    {
      label: "a coordinate-only root label",
      input: {
        location: "Lat 51.503407 / Long -0.127592",
        latitude: null,
        longitude: null,
      },
    },
  ])(
    "keeps $label ahead of an unrelated readable lot location",
    ({ input }) => {
      const normalized = normalizePreviewLocationData({
        ...input,
        lots: [
          {
            location: "Independent Storage Site",
            latitude: 49.8,
            longitude: -97.1,
          },
        ],
      });

      expect(normalized).toMatchObject({
        location: "",
        latitude: 51.503407,
        longitude: -0.127592,
      });
      expect(normalized.lots[0]).toMatchObject({
        location: "Independent Storage Site",
        latitude: 49.8,
        longitude: -97.1,
      });
    }
  );

  it("uses a readable lot only when the root has no location or coordinates", () => {
    const normalized = normalizePreviewLocationData({
      location: "",
      lots: [
        {
          location: "Fallback Inspection Site",
          latitude: 49.8,
          longitude: -97.1,
        },
      ],
    });

    expect(normalized).toMatchObject({
      location: "Fallback Inspection Site",
      latitude: 49.8,
      longitude: -97.1,
    });
  });

  it("clears inherited stale coordinates when a readable location is typed", () => {
    const edited = applyManualPreviewLocation(
      {
        location: "Old Inspection Yard",
        latitude: 50.1,
        longitude: -104.2,
        lots: [
          {
            location: "Old Inspection Yard",
            latitude: 50.1,
            longitude: -104.2,
          },
          {
            location: "Independent Storage Site",
            latitude: 49.8,
            longitude: -97.1,
          },
        ],
      },
      "New Inspection Yard"
    );

    expect(edited).toMatchObject({ latitude: null, longitude: null });
    expect(edited.lots[0]).toEqual({
      location: "New Inspection Yard",
      latitude: null,
      longitude: null,
    });
    expect(edited.lots[1]).toMatchObject({
      location: "Independent Storage Site",
      latitude: 49.8,
      longitude: -97.1,
    });
  });

  it("applies a reverse-geocoded place and coordinates atomically", () => {
    const resolved = applyResolvedPreviewLocation(
      {
        location: "",
        latitude: 51.503407,
        longitude: -0.127592,
        lots: [{ location: "Current Browser Location" }],
      },
      "10 Downing Street, London",
      { latitude: 51.503407, longitude: -0.127592 }
    );

    expect(resolved).toMatchObject({
      location: "10 Downing Street, London",
      latitude: 51.503407,
      longitude: -0.127592,
    });
    expect(resolved.lots[0]).toMatchObject({
      location: "10 Downing Street, London",
      latitude: 51.503407,
      longitude: -0.127592,
    });
  });
});
