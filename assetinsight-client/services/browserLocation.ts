import API from "@/lib/api";
import {
  hasUsableReportLocation,
  isValidBrowserCoordinates,
} from "@/lib/browserLocation";

export type ReverseGeocodedBrowserLocation = {
  location: string;
  currency?: string;
  attribution?: string;
  attributionUrl?: string;
  source?: string;
};

type ReverseGeocodeOptions = {
  signal?: AbortSignal;
};

function optionalText(
  value: unknown,
  field: "attribution" | "attributionUrl" | "source"
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`Reverse-geocode response ${field} must be text.`);
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function optionalAttributionUrl(value: unknown): string | undefined {
  const normalized = optionalText(value, "attributionUrl");
  if (!normalized) return undefined;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error();
    }
    return parsed.toString();
  } catch {
    throw new Error("Reverse-geocode response attributionUrl is invalid.");
  }
}

function parseReverseGeocodeResponse(
  value: unknown
): ReverseGeocodedBrowserLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reverse-geocode response is invalid.");
  }

  const candidate = value as Record<string, unknown>;
  if (!hasUsableReportLocation(candidate.location)) {
    throw new Error("Reverse geocoding did not return a readable location.");
  }

  let currency: string | undefined;
  if (candidate.currency !== undefined && candidate.currency !== null) {
    if (typeof candidate.currency !== "string") {
      throw new Error("Reverse-geocode response currency must be text.");
    }
    const normalizedCurrency = candidate.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      throw new Error("Reverse-geocode response currency is invalid.");
    }
    currency = normalizedCurrency;
  }

  const attribution = optionalText(candidate.attribution, "attribution");
  const attributionUrl = optionalAttributionUrl(candidate.attributionUrl);
  const source = optionalText(candidate.source, "source");

  return {
    location: String(candidate.location).trim(),
    ...(currency ? { currency } : {}),
    ...(attribution ? { attribution } : {}),
    ...(attributionUrl ? { attributionUrl } : {}),
    ...(source ? { source } : {}),
  };
}

function unwrapReverseGeocodePayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const envelope = value as Record<string, unknown>;
  return envelope.data &&
    typeof envelope.data === "object" &&
    !Array.isArray(envelope.data)
    ? envelope.data
    : value;
}

export const BrowserLocationService = {
  async reverseGeocode(
    coordinates: { latitude: number; longitude: number },
    options: ReverseGeocodeOptions = {}
  ): Promise<ReverseGeocodedBrowserLocation> {
    if (
      !isValidBrowserCoordinates(
        coordinates.latitude,
        coordinates.longitude
      )
    ) {
      throw new Error("Valid latitude and longitude are required.");
    }

    const response = await API.post<unknown>(
      "/location/reverse-geocode",
      {
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
      },
      { signal: options.signal }
    );
    return parseReverseGeocodeResponse(
      unwrapReverseGeocodePayload(response.data)
    );
  },
};
