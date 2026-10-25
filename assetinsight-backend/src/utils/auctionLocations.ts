export type AuctionLocationCoordinates = {
  latitude: number;
  longitude: number;
};

export const AUCTION_LOCATION_LIST = [
  "800 North Service Road, Emerald Park, SK",
  "203 60th Street East, Saskatoon, SK",
  "5221 Portage Ave, Headingley, MB",
  "8761 Wilkes Ave, Saint Eustache, MB",
  "601 17th Street East, Brandon, MB",
  "1209 - 8A Street, Nisku, AB",
  "6270 Dorman Rd, Mississauga, ON",
  "175 Chem. Du Grand-Pre, Saint-Jean-Sur-Richelieu, QC",
  "4728 I-35W, Alvarado, TX 76009",
  "Offsite",
] as const;

export const DEFAULT_AUCTION_LOCATION = AUCTION_LOCATION_LIST[0];
export const OFFSITE_AUCTION_LOCATION = "Offsite";

const LEGACY_BROWSER_LOCATION_LABEL = "Current Browser Location";
const COORDINATE_ONLY_LOCATION_PATTERN =
  /^\s*lat(?:itude)?\s*[:=]?\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:\/|,|;)\s*(?:long(?:itude)?|lon|lng)\s*[:=]?\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/i;

export const AUCTION_LOCATION_COORDINATES: Record<
  string,
  AuctionLocationCoordinates
> = {
  "800 North Service Road, Emerald Park, SK": {
    latitude: 50.44832,
    longitude: -104.39937,
  },
  "203 60th Street East, Saskatoon, SK": {
    latitude: 52.18733,
    longitude: -106.66773,
  },
  "5221 Portage Ave, Headingley, MB": {
    latitude: 49.87588,
    longitude: -97.39485,
  },
  "8761 Wilkes Ave, Saint Eustache, MB": {
    latitude: 49.83732,
    longitude: -97.37525,
  },
  "601 17th Street East, Brandon, MB": {
    latitude: 49.84017,
    longitude: -99.91557,
  },
  "1209 - 8A Street, Nisku, AB": {
    latitude: 53.31415,
    longitude: -113.51435,
  },
  "6270 Dorman Rd, Mississauga, ON": {
    latitude: 43.69555,
    longitude: -79.61189,
  },
  "175 Chem. Du Grand-Pre, Saint-Jean-Sur-Richelieu, QC": {
    latitude: 45.35048,
    longitude: -73.36109,
  },
  "4728 I-35W, Alvarado, TX 76009": {
    latitude: 32.43467,
    longitude: -97.2455,
  },
};

function cleanLocationText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

const DECIMAL_COORDINATE_PATTERN =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function toFiniteCoordinate(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!DECIMAL_COORDINATE_PATTERN.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasCoordinateFieldValue(value: unknown): boolean {
  return value !== undefined && value !== null &&
    !(typeof value === "string" && value.trim() === "");
}

export function hasAnyCoordinateInput(
  value: Record<string, any> | undefined | null
): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      (hasCoordinateFieldValue(value.latitude) ||
        hasCoordinateFieldValue(value.longitude))
  );
}

export function getExplicitCoordinates(
  value: Record<string, any> | undefined | null
): AuctionLocationCoordinates | undefined {
  if (!value || typeof value !== "object") return undefined;
  const latitude = toFiniteCoordinate(value.latitude);
  const longitude = toFiniteCoordinate(value.longitude);
  if (latitude === undefined || longitude === undefined) return undefined;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return undefined;
  }
  return { latitude, longitude };
}

export function isReadableAuctionLocation(value: unknown): boolean {
  const location = cleanLocationText(value);
  return Boolean(
    location &&
      location.toLowerCase() !== LEGACY_BROWSER_LOCATION_LABEL.toLowerCase() &&
      !COORDINATE_ONLY_LOCATION_PATTERN.test(location)
  );
}

function normalizeLocationKey(value: unknown): string {
  return cleanLocationText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const canonicalLocationByKey: Map<string, string> = new Map(
  AUCTION_LOCATION_LIST.map((location) => [
    normalizeLocationKey(location),
    location,
  ])
);

const legacyLocationAliases: Record<string, string> = {
  regina: "800 North Service Road, Emerald Park, SK",
  emeraldpark: "800 North Service Road, Emerald Park, SK",
  saskatoon: "203 60th Street East, Saskatoon, SK",
  headingley: "5221 Portage Ave, Headingley, MB",
  sainteustache: "8761 Wilkes Ave, Saint Eustache, MB",
  steustache: "8761 Wilkes Ave, Saint Eustache, MB",
  brandon: "601 17th Street East, Brandon, MB",
  nisku: "1209 - 8A Street, Nisku, AB",
  mississauga: "6270 Dorman Rd, Mississauga, ON",
  saintjeansurrichelieu: "175 Chem. Du Grand-Pre, Saint-Jean-Sur-Richelieu, QC",
  stjeansurrichelieu: "175 Chem. Du Grand-Pre, Saint-Jean-Sur-Richelieu, QC",
  alvarado: "4728 I-35W, Alvarado, TX 76009",
};

for (const [alias, location] of Object.entries(legacyLocationAliases)) {
  canonicalLocationByKey.set(normalizeLocationKey(alias), location);
}

export function resolveAuctionLocation(
  location?: unknown,
  fallbackLocation?: unknown
): string {
  const requested =
    cleanLocationText(location) ||
    cleanLocationText(fallbackLocation) ||
    DEFAULT_AUCTION_LOCATION;
  const canonical = canonicalLocationByKey.get(normalizeLocationKey(requested));
  return canonical || requested;
}

export function getAuctionLocationCoordinates(
  location?: unknown
): AuctionLocationCoordinates | undefined {
  const canonical = canonicalLocationByKey.get(normalizeLocationKey(location));
  return canonical && canonical !== OFFSITE_AUCTION_LOCATION
    ? AUCTION_LOCATION_COORDINATES[canonical]
    : undefined;
}

export function applyAuctionLocationCoordinatesToRecord<
  T extends Record<string, any>
>(record: T, fallbackLocation?: unknown): T {
  if (!record || typeof record !== "object") return record;

  const requestedLocation = isReadableAuctionLocation(record.location)
    ? cleanLocationText(record.location)
    : isReadableAuctionLocation(fallbackLocation)
      ? cleanLocationText(fallbackLocation)
      : "";
  const location = requestedLocation
    ? resolveAuctionLocation(requestedLocation)
    : "";
  const isOffsite = location === OFFSITE_AUCTION_LOCATION;
  const coordinates = isOffsite
    ? undefined
    : getExplicitCoordinates(record) || getAuctionLocationCoordinates(location);
  const {
    location: _location,
    latitude: _latitude,
    longitude: _longitude,
    ...recordWithoutLocation
  } = record;
  return {
    ...recordWithoutLocation,
    ...(location ? { location } : {}),
    ...(coordinates
      ? {
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
        }
      : {}),
  } as T;
}
