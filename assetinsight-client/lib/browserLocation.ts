export type BrowserCoordinates = {
  latitude: number;
  longitude: number;
  accuracy?: number;
};

type PreviewLocationRecord = Record<string, any>;

export const CURRENT_BROWSER_LOCATION_LABEL = "Current Browser Location";
export const OPENSTREETMAP_ATTRIBUTION = "© OpenStreetMap contributors";
export const OPENSTREETMAP_ATTRIBUTION_URL =
  "https://www.openstreetmap.org/copyright";

const COORDINATE_LOCATION_PATTERN =
  /^\s*lat(?:itude)?\s*[:=]?\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:\/|,|;)\s*(?:long(?:itude)?|lon|lng)\s*[:=]?\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*$/i;

const NON_LOCATION_LABELS = new Set([
  CURRENT_BROWSER_LOCATION_LABEL.toLowerCase(),
  "latitude/longitude not detected",
  "detecting browser location",
  "detecting current location",
]);

export const FRESH_HIGH_ACCURACY_POSITION_OPTIONS: Readonly<PositionOptions> =
  Object.freeze({
    enableHighAccuracy: true,
    timeout: 20_000,
    maximumAge: 0,
  });

function finiteCoordinate(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isValidBrowserCoordinates(
  latitude: unknown,
  longitude: unknown
): boolean {
  const parsedLatitude = finiteCoordinate(latitude);
  const parsedLongitude = finiteCoordinate(longitude);
  return (
    parsedLatitude !== null &&
    parsedLongitude !== null &&
    parsedLatitude >= -90 &&
    parsedLatitude <= 90 &&
    parsedLongitude >= -180 &&
    parsedLongitude <= 180
  );
}

export function getValidBrowserCoordinates(
  value: unknown
): BrowserCoordinates | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!isValidBrowserCoordinates(candidate.latitude, candidate.longitude)) {
    return null;
  }
  return {
    latitude: Number(candidate.latitude),
    longitude: Number(candidate.longitude),
  };
}

export function hasUsableReportLocation(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    !NON_LOCATION_LABELS.has(normalized.replace(/…|\.\.\.$/g, "").toLowerCase()) &&
    !isCoordinateOnlyReportLocation(normalized)
  );
}

export function parseBrowserCoordinateLocation(
  value: unknown
): BrowserCoordinates | null {
  if (typeof value !== "string") return null;
  const match = value.match(COORDINATE_LOCATION_PATTERN);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return isValidBrowserCoordinates(latitude, longitude)
    ? { latitude, longitude }
    : null;
}

export function isCoordinateOnlyReportLocation(value: unknown): boolean {
  return typeof value === "string" && COORDINATE_LOCATION_PATTERN.test(value);
}

export function formatBrowserLocationAttribution(value: unknown): string {
  const attribution =
    typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!attribution) return OPENSTREETMAP_ATTRIBUTION;
  if (/openstreetmap/i.test(attribution)) return attribution;
  return `${OPENSTREETMAP_ATTRIBUTION} · ${attribution}`;
}

export function formatBrowserCoordinates(
  latitude: unknown,
  longitude: unknown
): string {
  if (!isValidBrowserCoordinates(latitude, longitude)) {
    return "Latitude/Longitude not detected";
  }

  return `Lat ${Number(latitude).toFixed(6)} / Long ${Number(longitude).toFixed(6)}`;
}

export function formatBrowserAccuracyStatus(accuracy: unknown): string {
  const parsedAccuracy = finiteCoordinate(accuracy);
  if (parsedAccuracy === null || parsedAccuracy < 0) {
    return "Location accuracy unavailable";
  }

  return `Accurate to within approximately ${Math.max(
    1,
    Math.round(parsedAccuracy)
  )} m`;
}

function sameLocation(left: unknown, right: unknown): boolean {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.trim().toLowerCase() === right.trim().toLowerCase()
  );
}

function withoutCoordinates<T extends PreviewLocationRecord>(value: T): T {
  const next = { ...value };
  delete next.latitude;
  delete next.longitude;
  return next;
}

function withClearedCoordinates<T extends PreviewLocationRecord>(value: T): T {
  return { ...value, latitude: null, longitude: null };
}

/**
 * Prepares persisted preview data for final review without inventing a place
 * name. A legacy coordinate label is retained only as hidden coordinates so it
 * can be reverse-geocoded before the report is saved or submitted.
 */
export function normalizePreviewLocationData<T extends PreviewLocationRecord>(
  value: T
): T {
  const next: PreviewLocationRecord = withoutCoordinates(value || ({} as T));
  const rootCoordinates =
    getValidBrowserCoordinates(value) ||
    parseBrowserCoordinateLocation(value?.location);
  const lots = Array.isArray(value?.lots) ? value.lots : [];
  const readableLot = lots.find((lot: unknown) =>
    hasUsableReportLocation((lot as PreviewLocationRecord)?.location)
  ) as PreviewLocationRecord | undefined;
  const hasReadableRootLocation = hasUsableReportLocation(value?.location);
  const readableLocation = hasReadableRootLocation
    ? String(value.location).trim()
    : rootCoordinates
      ? ""
      : readableLot
        ? String(readableLot.location).trim()
        : "";
  const coordinates = hasReadableRootLocation || rootCoordinates
    ? rootCoordinates
    : readableLot
      ? getValidBrowserCoordinates(readableLot)
      : rootCoordinates ||
        lots.map(getValidBrowserCoordinates).find(Boolean) ||
        null;

  next.location = readableLocation;
  if (coordinates) {
    next.latitude = coordinates.latitude;
    next.longitude = coordinates.longitude;
  }
  return next as T;
}

/**
 * A typed place-name edit invalidates coordinates captured for the previous
 * place. Lots inheriting the report location are updated in the same atomic
 * state change; lots with an independent readable location are left alone.
 */
export function applyManualPreviewLocation<T extends PreviewLocationRecord>(
  value: T,
  location: string
): T {
  const previousLocation = value?.location;
  const next: PreviewLocationRecord = withClearedCoordinates({ ...value, location });
  if (!Array.isArray(value?.lots)) return next as T;
  next.lots = value.lots.map((lot: PreviewLocationRecord) => {
    const inheritsReportLocation =
      !hasUsableReportLocation(lot?.location) ||
      sameLocation(lot?.location, previousLocation);
    return inheritsReportLocation
      ? withClearedCoordinates({ ...lot, location })
      : lot;
  });
  return next as T;
}

export function applyResolvedPreviewLocation<T extends PreviewLocationRecord>(
  value: T,
  location: string,
  coordinates: BrowserCoordinates
): T {
  const previousLocation = value?.location;
  const next: PreviewLocationRecord = {
    ...value,
    location: location.trim(),
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
  };
  if (!Array.isArray(value?.lots)) return next as T;
  next.lots = value.lots.map((lot: PreviewLocationRecord) => {
    const inheritsReportLocation =
      !hasUsableReportLocation(lot?.location) ||
      sameLocation(lot?.location, previousLocation);
    return inheritsReportLocation
      ? {
          ...lot,
          location: location.trim(),
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
        }
      : lot;
  });
  return next as T;
}
