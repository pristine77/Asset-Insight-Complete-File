/**
 * Resolves lead locations and selects CRM agents by geographic coverage. Normalized
 * location results are cached to avoid repeated geocoding cost, and deterministic
 * tie-breaking keeps assignments stable when multiple agents cover the same area.
 */
import CrmGeoCache from "../models/crmGeoCache.model.js";
import User from "../models/user.model.js";
import openai from "../utils/openaiClient.js";
import { isReviewAccount } from "./reviewAccountPolicy.js";

export type CrmGeoLocation = {
  sourceText: string;
  normalizedText: string;
  countryCode: "CA" | "US" | "";
  regionCode: string;
  regionName: string;
  city: string;
  postalCode: string;
  lat?: number;
  lng?: number;
  confidence: number;
  resolver: "openai" | "heuristic" | "empty";
};

export type PreparedCrmAssignee = {
  user: any;
  geo: CrmGeoLocation;
};

export type CrmAssignmentChoice = {
  assignee: any;
  assigneeGeo: CrmGeoLocation;
  leadGeo: CrmGeoLocation;
  method: "distance" | "region" | "country" | "load_balance";
  distanceKm?: number;
  matchedRegion?: string;
  reason: string;
};

type RegionInfo = {
  code: string;
  name: string;
  countryCode: "CA" | "US";
  lat: number;
  lng: number;
  aliases: string[];
};

const REGION_DATA: RegionInfo[] = [
  { code: "AL", name: "Alabama", countryCode: "US", lat: 32.8067, lng: -86.7911, aliases: ["alabama"] },
  { code: "AK", name: "Alaska", countryCode: "US", lat: 61.3707, lng: -152.4044, aliases: ["alaska"] },
  { code: "AZ", name: "Arizona", countryCode: "US", lat: 33.7298, lng: -111.4312, aliases: ["arizona"] },
  { code: "AR", name: "Arkansas", countryCode: "US", lat: 34.9697, lng: -92.3731, aliases: ["arkansas"] },
  { code: "CA", name: "California", countryCode: "US", lat: 36.1162, lng: -119.6816, aliases: ["california"] },
  { code: "CO", name: "Colorado", countryCode: "US", lat: 39.0598, lng: -105.3111, aliases: ["colorado"] },
  { code: "CT", name: "Connecticut", countryCode: "US", lat: 41.5978, lng: -72.7554, aliases: ["connecticut"] },
  { code: "DE", name: "Delaware", countryCode: "US", lat: 39.3185, lng: -75.5071, aliases: ["delaware"] },
  { code: "FL", name: "Florida", countryCode: "US", lat: 27.7663, lng: -81.6868, aliases: ["florida"] },
  { code: "GA", name: "Georgia", countryCode: "US", lat: 33.0406, lng: -83.6431, aliases: ["georgia"] },
  { code: "HI", name: "Hawaii", countryCode: "US", lat: 21.0943, lng: -157.4983, aliases: ["hawaii"] },
  { code: "ID", name: "Idaho", countryCode: "US", lat: 44.2405, lng: -114.4788, aliases: ["idaho"] },
  { code: "IL", name: "Illinois", countryCode: "US", lat: 40.3495, lng: -88.9861, aliases: ["illinois"] },
  { code: "IN", name: "Indiana", countryCode: "US", lat: 39.8494, lng: -86.2583, aliases: ["indiana"] },
  { code: "IA", name: "Iowa", countryCode: "US", lat: 42.0115, lng: -93.2105, aliases: ["iowa"] },
  { code: "KS", name: "Kansas", countryCode: "US", lat: 38.5266, lng: -96.7265, aliases: ["kansas"] },
  { code: "KY", name: "Kentucky", countryCode: "US", lat: 37.6681, lng: -84.6701, aliases: ["kentucky"] },
  { code: "LA", name: "Louisiana", countryCode: "US", lat: 31.1695, lng: -91.8678, aliases: ["louisiana"] },
  { code: "ME", name: "Maine", countryCode: "US", lat: 44.6939, lng: -69.3819, aliases: ["maine"] },
  { code: "MD", name: "Maryland", countryCode: "US", lat: 39.0639, lng: -76.8021, aliases: ["maryland"] },
  { code: "MA", name: "Massachusetts", countryCode: "US", lat: 42.2302, lng: -71.5301, aliases: ["massachusetts"] },
  { code: "MI", name: "Michigan", countryCode: "US", lat: 43.3266, lng: -84.5361, aliases: ["michigan"] },
  { code: "MN", name: "Minnesota", countryCode: "US", lat: 45.6945, lng: -93.9002, aliases: ["minnesota"] },
  { code: "MS", name: "Mississippi", countryCode: "US", lat: 32.7416, lng: -89.6787, aliases: ["mississippi"] },
  { code: "MO", name: "Missouri", countryCode: "US", lat: 38.4561, lng: -92.2884, aliases: ["missouri"] },
  { code: "MT", name: "Montana", countryCode: "US", lat: 46.9219, lng: -110.4544, aliases: ["montana"] },
  { code: "NE", name: "Nebraska", countryCode: "US", lat: 41.1254, lng: -98.2681, aliases: ["nebraska"] },
  { code: "NV", name: "Nevada", countryCode: "US", lat: 38.3135, lng: -117.0554, aliases: ["nevada"] },
  { code: "NH", name: "New Hampshire", countryCode: "US", lat: 43.4525, lng: -71.5639, aliases: ["new hampshire"] },
  { code: "NJ", name: "New Jersey", countryCode: "US", lat: 40.2989, lng: -74.521, aliases: ["new jersey"] },
  { code: "NM", name: "New Mexico", countryCode: "US", lat: 34.8405, lng: -106.2485, aliases: ["new mexico"] },
  { code: "NY", name: "New York", countryCode: "US", lat: 42.1657, lng: -74.9481, aliases: ["new york"] },
  { code: "NC", name: "North Carolina", countryCode: "US", lat: 35.6301, lng: -79.8064, aliases: ["north carolina"] },
  { code: "ND", name: "North Dakota", countryCode: "US", lat: 47.5289, lng: -99.784, aliases: ["north dakota"] },
  { code: "OH", name: "Ohio", countryCode: "US", lat: 40.3888, lng: -82.7649, aliases: ["ohio"] },
  { code: "OK", name: "Oklahoma", countryCode: "US", lat: 35.5653, lng: -96.9289, aliases: ["oklahoma"] },
  { code: "OR", name: "Oregon", countryCode: "US", lat: 44.572, lng: -122.0709, aliases: ["oregon"] },
  { code: "PA", name: "Pennsylvania", countryCode: "US", lat: 40.5908, lng: -77.2098, aliases: ["pennsylvania"] },
  { code: "RI", name: "Rhode Island", countryCode: "US", lat: 41.6809, lng: -71.5118, aliases: ["rhode island"] },
  { code: "SC", name: "South Carolina", countryCode: "US", lat: 33.8569, lng: -80.945, aliases: ["south carolina"] },
  { code: "SD", name: "South Dakota", countryCode: "US", lat: 44.2998, lng: -99.4388, aliases: ["south dakota"] },
  { code: "TN", name: "Tennessee", countryCode: "US", lat: 35.7478, lng: -86.6923, aliases: ["tennessee"] },
  { code: "TX", name: "Texas", countryCode: "US", lat: 31.0545, lng: -97.5635, aliases: ["texas"] },
  { code: "UT", name: "Utah", countryCode: "US", lat: 40.15, lng: -111.8624, aliases: ["utah"] },
  { code: "VT", name: "Vermont", countryCode: "US", lat: 44.0459, lng: -72.7107, aliases: ["vermont"] },
  { code: "VA", name: "Virginia", countryCode: "US", lat: 37.7693, lng: -78.17, aliases: ["virginia"] },
  { code: "WA", name: "Washington", countryCode: "US", lat: 47.4009, lng: -121.4905, aliases: ["washington"] },
  { code: "WV", name: "West Virginia", countryCode: "US", lat: 38.4912, lng: -80.9545, aliases: ["west virginia"] },
  { code: "WI", name: "Wisconsin", countryCode: "US", lat: 44.2685, lng: -89.6165, aliases: ["wisconsin"] },
  { code: "WY", name: "Wyoming", countryCode: "US", lat: 42.756, lng: -107.3025, aliases: ["wyoming"] },
  { code: "DC", name: "District of Columbia", countryCode: "US", lat: 38.9072, lng: -77.0369, aliases: ["district of columbia", "washington dc"] },
  { code: "AB", name: "Alberta", countryCode: "CA", lat: 53.9333, lng: -116.5765, aliases: ["alberta"] },
  { code: "BC", name: "British Columbia", countryCode: "CA", lat: 53.7267, lng: -127.6476, aliases: ["british columbia"] },
  { code: "MB", name: "Manitoba", countryCode: "CA", lat: 53.7609, lng: -98.8139, aliases: ["manitoba"] },
  { code: "NB", name: "New Brunswick", countryCode: "CA", lat: 46.5653, lng: -66.4619, aliases: ["new brunswick"] },
  { code: "NL", name: "Newfoundland and Labrador", countryCode: "CA", lat: 53.1355, lng: -57.6604, aliases: ["newfoundland", "newfoundland and labrador", "labrador"] },
  { code: "NS", name: "Nova Scotia", countryCode: "CA", lat: 44.682, lng: -63.7443, aliases: ["nova scotia"] },
  { code: "ON", name: "Ontario", countryCode: "CA", lat: 51.2538, lng: -85.3232, aliases: ["ontario"] },
  { code: "PE", name: "Prince Edward Island", countryCode: "CA", lat: 46.5107, lng: -63.4168, aliases: ["prince edward island", "pei"] },
  { code: "QC", name: "Quebec", countryCode: "CA", lat: 52.9399, lng: -73.5491, aliases: ["quebec"] },
  { code: "SK", name: "Saskatchewan", countryCode: "CA", lat: 52.9399, lng: -106.4509, aliases: ["saskatchewan"] },
  { code: "NT", name: "Northwest Territories", countryCode: "CA", lat: 64.8255, lng: -124.8457, aliases: ["northwest territories"] },
  { code: "NU", name: "Nunavut", countryCode: "CA", lat: 70.2998, lng: -83.1076, aliases: ["nunavut"] },
  { code: "YT", name: "Yukon", countryCode: "CA", lat: 64.2823, lng: -135, aliases: ["yukon"] },
];

const COUNTRY_CENTROIDS = {
  CA: { lat: 56.1304, lng: -106.3468, name: "Canada" },
  US: { lat: 39.8283, lng: -98.5795, name: "United States" },
} as const;

const regionByCountryAndCode = new Map(REGION_DATA.map((region) => [`${region.countryCode}:${region.code}`, region]));
const regionAliasMap = new Map<string, RegionInfo>();
for (const region of REGION_DATA) {
  regionAliasMap.set(`${region.countryCode}:${normalizeGeoText(region.code)}`, region);
  regionAliasMap.set(normalizeGeoText(region.name), region);
  for (const alias of region.aliases) {
    regionAliasMap.set(normalizeGeoText(alias), region);
  }
}

function normalizeGeoText(value: unknown): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function buildCacheKey(value: unknown): string {
  return normalizeGeoText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function toCleanString(value: unknown): string {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function clampConfidence(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function validCoordinate(lat: unknown, lng: unknown): { lat?: number; lng?: number } {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return {};
  if (latitude < 18 || latitude > 84 || longitude < -180 || longitude > -45) return {};
  return { lat: latitude, lng: longitude };
}

function parseCountryCode(value: unknown): "CA" | "US" | "" {
  const normalized = normalizeGeoText(value).replace(/\./g, "");
  if (["ca", "can", "canada"].includes(normalized)) return "CA";
  if (["us", "usa", "united states", "united states of america", "america"].includes(normalized)) return "US";
  return "";
}

function findRegion(value: unknown, countryCode?: "CA" | "US" | ""): RegionInfo | undefined {
  const normalized = normalizeGeoText(value);
  if (!normalized) return undefined;
  if (countryCode) {
    const byCountry = regionAliasMap.get(`${countryCode}:${normalized}`);
    if (byCountry) return byCountry;
  }
  return regionAliasMap.get(normalized);
}

function inferRegionFromText(text: string): RegionInfo | undefined {
  const normalized = normalizeGeoText(text);
  for (const region of REGION_DATA) {
    const names = [region.name, ...region.aliases].map((entry) => normalizeGeoText(entry));
    if (names.some((name) => name && new RegExp(`(^|[^a-z0-9])${escapeRegex(name)}([^a-z0-9]|$)`).test(normalized))) {
      return region;
    }
  }

  const rawTokens = String(text || "").split(/[\s,;()]+/g).filter(Boolean);
  for (const rawToken of rawTokens) {
    const token = rawToken.replace(/[^a-zA-Z]/g, "").toUpperCase();
    if (token.length !== 2) continue;
    const candidates = REGION_DATA.filter((region) => region.code === token);
    if (candidates.length === 1) return candidates[0];
    const country = inferCountryFromText(text);
    const countryCandidate = candidates.find((region) => region.countryCode === country);
    if (countryCandidate) return countryCandidate;
  }
  return undefined;
}

function inferCountryFromText(text: string): "CA" | "US" | "" {
  const normalized = normalizeGeoText(text);
  if (/\b(canada|canadian)\b/.test(normalized)) return "CA";
  if (/\b(united states|usa|u s a|u\.s\.a|us)\b/.test(normalized)) return "US";
  const region = inferRegionFromTextWithoutCountry(text);
  return region?.countryCode || "";
}

function inferRegionFromTextWithoutCountry(text: string): RegionInfo | undefined {
  const normalized = normalizeGeoText(text);
  for (const region of REGION_DATA) {
    const names = [region.name, ...region.aliases].map((entry) => normalizeGeoText(entry));
    if (names.some((name) => name && new RegExp(`(^|[^a-z0-9])${escapeRegex(name)}([^a-z0-9]|$)`).test(normalized))) {
      return region;
    }
  }
  return undefined;
}

function extractPostalCode(text: string, countryCode: "CA" | "US" | ""): string {
  const raw = String(text || "").toUpperCase();
  if (countryCode === "CA" || !countryCode) {
    const ca = raw.match(/[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d/);
    if (ca?.[0]) return ca[0].replace(/\s+/g, " ").trim();
  }
  if (countryCode === "US" || !countryCode) {
    const us = raw.match(/\b\d{5}(?:-\d{4})?\b/);
    if (us?.[0]) return us[0];
  }
  return "";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function heuristicLocation(sourceText: string): CrmGeoLocation {
  const region = inferRegionFromText(sourceText);
  const countryCode = region?.countryCode || inferCountryFromText(sourceText);
  const countryCentroid = countryCode ? COUNTRY_CENTROIDS[countryCode] : undefined;
  return {
    sourceText,
    normalizedText: sourceText,
    countryCode,
    regionCode: region?.code || "",
    regionName: region?.name || (countryCentroid?.name ?? ""),
    city: "",
    postalCode: extractPostalCode(sourceText, countryCode),
    lat: region?.lat ?? countryCentroid?.lat,
    lng: region?.lng ?? countryCentroid?.lng,
    confidence: region ? 0.6 : countryCode ? 0.3 : 0,
    resolver: sourceText.trim() ? "heuristic" : "empty",
  };
}

/**
 * Fast deterministic location normalization for bulk imports. A large
 * spreadsheet must never issue one model request per row.
 */
export function normalizeCrmGeoLocationHeuristic(sourceTextInput: unknown): CrmGeoLocation {
  return heuristicLocation(toCleanString(sourceTextInput));
}

function mergeAndValidateGeo(sourceText: string, ai: any, fallback: CrmGeoLocation): CrmGeoLocation {
  const aiCountry = parseCountryCode(ai?.countryCode || ai?.country);
  let region = findRegion(ai?.regionCode, aiCountry || fallback.countryCode) || findRegion(ai?.regionName, aiCountry || fallback.countryCode);
  if (!region && fallback.regionCode) {
    region = regionByCountryAndCode.get(`${fallback.countryCode}:${fallback.regionCode}`);
  }
  const countryCode = region?.countryCode || aiCountry || fallback.countryCode;
  const countryCentroid = countryCode ? COUNTRY_CENTROIDS[countryCode] : undefined;
  const coords = validCoordinate(ai?.lat ?? ai?.latitude, ai?.lng ?? ai?.lon ?? ai?.longitude);
  const hasAiCoords = Boolean(coords.lat !== undefined && coords.lng !== undefined && ai?.hasCoordinates !== false);

  return {
    sourceText,
    normalizedText: toCleanString(ai?.normalizedText) || fallback.normalizedText || sourceText,
    countryCode,
    regionCode: region?.code || fallback.regionCode || "",
    regionName: region?.name || fallback.regionName || countryCentroid?.name || "",
    city: toCleanString(ai?.city) || fallback.city || "",
    postalCode: toCleanString(ai?.postalCode) || fallback.postalCode || extractPostalCode(sourceText, countryCode),
    lat: hasAiCoords ? coords.lat : region?.lat ?? fallback.lat ?? countryCentroid?.lat,
    lng: hasAiCoords ? coords.lng : region?.lng ?? fallback.lng ?? countryCentroid?.lng,
    confidence: Math.max(clampConfidence(ai?.confidence, 0), fallback.confidence),
    resolver: "openai",
  };
}

async function normalizeWithOpenAI(sourceText: string, fallback: CrmGeoLocation): Promise<CrmGeoLocation> {
  if (!process.env.OPENAI_API_KEY) return fallback;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "crm_geo_location",
        strict: true,
        schema: {
          type: "object",
          properties: {
            normalizedText: { type: "string" },
            countryCode: { type: "string" },
            regionCode: { type: "string" },
            regionName: { type: "string" },
            city: { type: "string" },
            postalCode: { type: "string" },
            hasCoordinates: { type: "boolean" },
            lat: { type: "number" },
            lng: { type: "number" },
            confidence: { type: "number" },
          },
          required: [
            "normalizedText",
            "countryCode",
            "regionCode",
            "regionName",
            "city",
            "postalCode",
            "hasCoordinates",
            "lat",
            "lng",
            "confidence",
          ],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "system",
        content:
          "Normalize a North American CRM lead or salesperson service location. Return JSON only. Use countryCode CA or US. Use official two-letter state/province codes. If exact coordinates are unknown, provide best approximate city or region centroid and lower confidence.",
      },
      {
        role: "user",
        content: `Location: ${sourceText}`,
      },
    ],
  } as any);

  const content = String(completion.choices?.[0]?.message?.content || "").trim();
  if (!content) return fallback;
  return mergeAndValidateGeo(sourceText, JSON.parse(content), fallback);
}

export async function normalizeCrmGeoLocation(sourceTextInput: unknown): Promise<CrmGeoLocation> {
  const sourceText = toCleanString(sourceTextInput);
  const cacheKey = buildCacheKey(sourceText);
  if (!cacheKey) return heuristicLocation("");

  const cached = await CrmGeoCache.findOne({ cacheKey }).lean();
  if (cached?.result) {
    return {
      ...(cached.result as CrmGeoLocation),
      sourceText,
    };
  }

  const fallback = heuristicLocation(sourceText);
  let result = fallback;
  let error = "";
  try {
    result = await normalizeWithOpenAI(sourceText, fallback);
  } catch (e: any) {
    error = e?.message || String(e);
    result = fallback;
  }

  await CrmGeoCache.findOneAndUpdate(
    { cacheKey },
    {
      $set: {
        cacheKey,
        sourceText,
        normalizedText: result.normalizedText,
        resolver: result.resolver,
        result,
        error: error || undefined,
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  ).catch((cacheError) => {
    console.error("normalizeCrmGeoLocation cache write error", cacheError);
  });

  return result;
}

export function buildLeadGeoSource(input: {
  companyLocation?: string;
  contactLocation?: string;
  companyPostCode?: string;
}): string {
  return [input.companyLocation, input.contactLocation, input.companyPostCode]
    .map((value) => toCleanString(value))
    .filter(Boolean)
    .filter((value, index, source) => source.indexOf(value) === index)
    .join(", ");
}

export async function prepareCrmAssignees(users: any[]): Promise<PreparedCrmAssignee[]> {
  const prepared: PreparedCrmAssignee[] = [];
  for (const user of users) {
    // Production assignment must never enroll isolated review identities, even
    // when a caller passes an explicit or previously prepared candidate list.
    if (isReviewAccount(user)) continue;
    const geo = await normalizeCrmGeoLocation((user as any)?.crmAddress || "");
    prepared.push({ user, geo });
    const userId = String((user as any)?._id || "");
    if (userId && (user as any)?.crmAddress) {
      await User.updateOne({ _id: userId }, { $set: { crmGeo: geo } }).catch((e) => {
        console.error("prepareCrmAssignees user geo update error", e);
      });
    }
  }
  return prepared;
}

function hasCoordinates(geo: CrmGeoLocation): boolean {
  return typeof geo.lat === "number" && typeof geo.lng === "number";
}

function hasAssignmentCoordinates(geo: CrmGeoLocation): boolean {
  return hasCoordinates(geo) && geo.confidence >= 0.45 && Boolean(geo.regionCode || geo.city || geo.postalCode);
}

function distanceKm(a: CrmGeoLocation, b: CrmGeoLocation): number {
  if (!hasAssignmentCoordinates(a) || !hasAssignmentCoordinates(b)) return Number.POSITIVE_INFINITY;
  const r = 6371;
  const dLat = ((b.lat as number) - (a.lat as number)) * Math.PI / 180;
  const dLng = ((b.lng as number) - (a.lng as number)) * Math.PI / 180;
  const lat1 = (a.lat as number) * Math.PI / 180;
  const lat2 = (b.lat as number) * Math.PI / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function chooseNearestCrmAssignee(input: {
  leadGeo: CrmGeoLocation;
  leadSpecialization?: string;
  assignees: PreparedCrmAssignee[];
  assigneeLoadMap: Map<string, number>;
}): CrmAssignmentChoice {
  const { leadGeo, leadSpecialization, assignees, assigneeLoadMap } = input;
  const ranked = assignees.filter((entry) => !isReviewAccount(entry.user)).map((entry) => {
    const dist = distanceKm(leadGeo, entry.geo);
    const sameRegion = Boolean(
      leadGeo.regionCode &&
      entry.geo.regionCode &&
      leadGeo.countryCode === entry.geo.countryCode &&
      leadGeo.regionCode === entry.geo.regionCode
    );
    const sameCountry = Boolean(leadGeo.countryCode && entry.geo.countryCode && leadGeo.countryCode === entry.geo.countryCode);
    const specializations = Array.isArray((entry.user as any)?.crmSpecializations)
      ? ((entry.user as any).crmSpecializations as string[])
      : [];
    const specializationMatch = leadSpecialization ? specializations.includes(leadSpecialization) : false;
    const userId = String((entry.user as any)?._id || "");
    const load = assigneeLoadMap.get(userId) || 0;
    const geoRank = Number.isFinite(dist) ? 0 : sameRegion ? 1 : sameCountry ? 2 : 3;
    return { entry, dist, sameRegion, sameCountry, specializationMatch, load, geoRank, userId };
  });

  ranked.sort((a, b) => {
    if (a.geoRank !== b.geoRank) return a.geoRank - b.geoRank;
    if (a.geoRank === 0 && Math.abs(a.dist - b.dist) > 25) return a.dist - b.dist;
    if (a.geoRank === 1 && a.sameRegion !== b.sameRegion) return a.sameRegion ? -1 : 1;
    if (a.specializationMatch !== b.specializationMatch) return a.specializationMatch ? -1 : 1;
    if (a.load !== b.load) return a.load - b.load;
    return a.userId.localeCompare(b.userId);
  });

  const best = ranked[0];
  if (!best) {
    throw new Error("No active CRM users available for assignment");
  }

  const method: CrmAssignmentChoice["method"] =
    best.geoRank === 0 ? "distance" : best.geoRank === 1 ? "region" : best.geoRank === 2 ? "country" : "load_balance";
  const matchedRegion = best.sameRegion ? `${leadGeo.countryCode}-${leadGeo.regionCode}` : "";
  const distance = Number.isFinite(best.dist) ? Math.round(best.dist * 10) / 10 : undefined;

  return {
    assignee: best.entry.user,
    assigneeGeo: best.entry.geo,
    leadGeo,
    method,
    distanceKm: distance,
    matchedRegion,
    reason:
      method === "distance"
        ? `Nearest CRM address${distance !== undefined ? ` (${distance} km)` : ""}`
        : method === "region"
        ? `Same state/province ${matchedRegion}`
        : method === "country"
        ? `Same country ${leadGeo.countryCode}`
        : "Load-balanced fallback; lead or salesperson location is incomplete",
  };
}
