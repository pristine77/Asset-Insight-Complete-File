const DEFAULT_NOMINATIM_REVERSE_URL =
  "https://nominatim.openstreetmap.org/reverse";
const DEFAULT_NOMINATIM_USER_AGENT =
  "AssetInsight/1.0 (+https://assetinsightvaluator.com)";
const PROVIDER_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 1_000;
const MIN_PROVIDER_INTERVAL_MS = 1_050;
export const BROWSER_LOCATION_MAX_PENDING_LOOKUPS = 8;
export const BROWSER_LOCATION_RATE_LIMIT_MAX_REQUESTS = 6;
export const BROWSER_LOCATION_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_IDENTITIES = 10_000;

const COUNTRY_CODE_TO_CURRENCY: Readonly<Record<string, string>> = Object.freeze({
  AE: "AED",
  AR: "ARS",
  AU: "AUD",
  BD: "BDT",
  BE: "EUR",
  BR: "BRL",
  CA: "CAD",
  CL: "CLP",
  CN: "CNY",
  CO: "COP",
  DE: "EUR",
  EG: "EGP",
  ES: "EUR",
  FR: "EUR",
  GB: "GBP",
  GH: "GHS",
  HK: "HKD",
  ID: "IDR",
  IE: "EUR",
  IN: "INR",
  IT: "EUR",
  JP: "JPY",
  KE: "KES",
  KR: "KRW",
  LK: "LKR",
  MX: "MXN",
  MY: "MYR",
  NG: "NGN",
  NL: "EUR",
  NZ: "NZD",
  PE: "PEN",
  PH: "PHP",
  PK: "PKR",
  PT: "EUR",
  SA: "SAR",
  SG: "SGD",
  TH: "THB",
  TR: "TRY",
  TW: "TWD",
  US: "USD",
  VE: "VES",
  VN: "VND",
  ZA: "ZAR",
});

export type BrowserLocationResult = Readonly<{
  location: string;
  countryCode?: string;
  currency?: string;
  source: "openstreetmap";
  attribution: string;
  attributionUrl: string;
}>;

type CachedLocation = {
  expiresAt: number;
  value: BrowserLocationResult;
};

type InFlightLookup = {
  controller: AbortController;
  promise: Promise<BrowserLocationResult>;
  settled: boolean;
  subscribers: number;
};

type ProviderTask = {
  reject: (reason: unknown) => void;
  request: () => Promise<BrowserLocationResult>;
  resolve: (value: BrowserLocationResult) => void;
  signal: AbortSignal;
  state: "queued" | "active" | "settled";
  onQueuedAbort: () => void;
};

type RateLimitBucket = {
  count: number;
  windowStartedAt: number;
};

export type BrowserLocationRateLimitResult = Readonly<{
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}>;

export class BrowserLocationProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserLocationProviderError";
  }
}

export class BrowserLocationCapacityError extends Error {
  readonly retryAfterSeconds: number;

  constructor() {
    super("Too many browser location lookups are already pending.");
    this.name = "BrowserLocationCapacityError";
    this.retryAfterSeconds = Math.ceil(
      (BROWSER_LOCATION_MAX_PENDING_LOOKUPS * MIN_PROVIDER_INTERVAL_MS) / 1_000
    );
  }
}

export class BrowserLocationRequestAbortedError extends Error {
  constructor() {
    super("The browser location request was cancelled.");
    this.name = "BrowserLocationRequestAbortedError";
  }
}

const locationCache = new Map<string, CachedLocation>();
const inFlightLookups = new Map<string, InFlightLookup>();
const providerTasks: ProviderTask[] = [];
const rateLimitBuckets = new Map<string, RateLimitBucket>();
let providerQueueRunning = false;
let nextProviderRequestAt = 0;

function normalizeLanguage(value: unknown): string {
  const primary = String(value || "en")
    .split(",")[0]
    ?.trim()
    .split(";")[0]
    ?.trim();
  const language = primary?.split("-")[0]?.toLowerCase();
  return /^[a-z]{2,3}$/.test(language || "") ? language! : "en";
}

function cleanLocationText(value: unknown): string {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function buildAddressFallback(address: Record<string, unknown>): string {
  const settlement =
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.hamlet ||
    address.suburb;
  const values = [
    address.house_number,
    address.road,
    settlement,
    address.state,
    address.postcode,
    address.country,
  ]
    .map(cleanLocationText)
    .filter(Boolean);
  return [...new Set(values)].join(", ").slice(0, 500);
}

function parseProviderResult(payload: unknown): BrowserLocationResult {
  const data = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
  const address = data.address && typeof data.address === "object"
    ? (data.address as Record<string, unknown>)
    : {};
  const location =
    cleanLocationText(data.display_name) || buildAddressFallback(address);
  if (!location) {
    throw new BrowserLocationProviderError(
      "The location provider did not return a place name."
    );
  }
  const countryCode = cleanLocationText(address.country_code).toUpperCase();
  return Object.freeze({
    location,
    ...(countryCode ? { countryCode } : {}),
    ...(COUNTRY_CODE_TO_CURRENCY[countryCode]
      ? { currency: COUNTRY_CODE_TO_CURRENCY[countryCode] }
      : {}),
    source: "openstreetmap" as const,
    attribution: "© OpenStreetMap contributors",
    attributionUrl: "https://www.openstreetmap.org/copyright",
  });
}

function cacheKey(latitude: number, longitude: number, language: string): string {
  return `${latitude.toFixed(5)},${longitude.toFixed(5)},${language}`;
}

function readCachedLocation(key: string): BrowserLocationResult | null {
  const cached = locationCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    locationCache.delete(key);
    return null;
  }
  // Refresh insertion order so the size cap behaves as a small LRU cache.
  locationCache.delete(key);
  locationCache.set(key, cached);
  return cached.value;
}

function writeCachedLocation(key: string, value: BrowserLocationResult): void {
  locationCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  while (locationCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = locationCache.keys().next().value;
    if (!oldestKey) break;
    locationCache.delete(oldestKey);
  }
}

function removeProviderTask(task: ProviderTask): void {
  const index = providerTasks.indexOf(task);
  if (index >= 0) providerTasks.splice(index, 1);
}

function settleProviderTask(task: ProviderTask): void {
  task.state = "settled";
  task.signal.removeEventListener("abort", task.onQueuedAbort);
}

function waitForProviderSlot(waitMs: number, signal: AbortSignal): Promise<void> {
  if (waitMs <= 0 || process.env.NODE_ENV === "test") {
    if (signal.aborted) {
      return Promise.reject(new BrowserLocationRequestAbortedError());
    }
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new BrowserLocationRequestAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function drainProviderQueue(): Promise<void> {
  if (providerQueueRunning) return;
  providerQueueRunning = true;

  try {
    while (providerTasks.length > 0) {
      const task = providerTasks.shift();
      if (!task || task.state !== "queued") continue;
      task.state = "active";
      task.signal.removeEventListener("abort", task.onQueuedAbort);

      try {
        await waitForProviderSlot(
          Math.max(0, nextProviderRequestAt - Date.now()),
          task.signal
        );
        if (task.signal.aborted) {
          throw new BrowserLocationRequestAbortedError();
        }
        nextProviderRequestAt = Date.now() + MIN_PROVIDER_INTERVAL_MS;
        task.resolve(await task.request());
      } catch (error) {
        task.reject(error);
      } finally {
        settleProviderTask(task);
      }
    }
  } finally {
    providerQueueRunning = false;
    if (providerTasks.length > 0) void drainProviderQueue();
  }
}

function runProviderRequest(
  request: () => Promise<BrowserLocationResult>,
  signal: AbortSignal
): Promise<BrowserLocationResult> {
  if (signal.aborted) {
    return Promise.reject(new BrowserLocationRequestAbortedError());
  }

  return new Promise((resolve, reject) => {
    let task!: ProviderTask;
    const onQueuedAbort = () => {
      if (task.state !== "queued") return;
      removeProviderTask(task);
      settleProviderTask(task);
      reject(new BrowserLocationRequestAbortedError());
    };
    task = {
      request,
      resolve,
      reject,
      signal,
      state: "queued",
      onQueuedAbort,
    };
    signal.addEventListener("abort", task.onQueuedAbort, { once: true });
    providerTasks.push(task);
    void drainProviderQueue();
  });
}

async function fetchLocation(
  latitude: number,
  longitude: number,
  language: string,
  signal: AbortSignal
): Promise<BrowserLocationResult> {
  return runProviderRequest(async () => {
    const reverseUrl = new URL(
      process.env.NOMINATIM_REVERSE_URL || DEFAULT_NOMINATIM_REVERSE_URL
    );
    reverseUrl.searchParams.set("format", "jsonv2");
    reverseUrl.searchParams.set("lat", String(latitude));
    reverseUrl.searchParams.set("lon", String(longitude));
    reverseUrl.searchParams.set("zoom", "18");
    reverseUrl.searchParams.set("addressdetails", "1");
    reverseUrl.searchParams.set("accept-language", language);

    const controller = new AbortController();
    const abortProviderRequest = () => controller.abort();
    signal.addEventListener("abort", abortProviderRequest, { once: true });
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
      if (signal.aborted) {
        throw new BrowserLocationRequestAbortedError();
      }
      const response = await fetch(reverseUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            process.env.NOMINATIM_USER_AGENT ||
            DEFAULT_NOMINATIM_USER_AGENT,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new BrowserLocationProviderError(
          `The location provider returned HTTP ${response.status}.`
        );
      }
      return parseProviderResult(await response.json());
    } catch (error) {
      if (error instanceof BrowserLocationRequestAbortedError) throw error;
      if (error instanceof BrowserLocationProviderError) throw error;
      if ((error as Error)?.name === "AbortError") {
        if (signal.aborted) {
          throw new BrowserLocationRequestAbortedError();
        }
        throw new BrowserLocationProviderError(
          "The location provider timed out."
        );
      }
      throw new BrowserLocationProviderError(
        "The location provider is temporarily unavailable."
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortProviderRequest);
    }
  }, signal);
}

function subscribeToLookup(
  entry: InFlightLookup,
  signal?: AbortSignal
): Promise<BrowserLocationResult> {
  if (signal?.aborted) {
    return Promise.reject(new BrowserLocationRequestAbortedError());
  }

  entry.subscribers += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (entry.subscribers === 0 && !entry.settled) {
        entry.controller.abort();
      }
      return true;
    };
    const onAbort = () => {
      if (!finish()) return;
      reject(new BrowserLocationRequestAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (value) => {
        if (!finish()) return;
        resolve(value);
      },
      (error) => {
        if (!finish()) return;
        reject(error);
      }
    );
  });
}

function trimRateLimitBuckets(now: number): void {
  for (const [identity, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStartedAt >= BROWSER_LOCATION_RATE_LIMIT_WINDOW_MS) {
      rateLimitBuckets.delete(identity);
    }
  }
  while (rateLimitBuckets.size >= MAX_RATE_LIMIT_IDENTITIES) {
    const oldestIdentity = rateLimitBuckets.keys().next().value;
    if (!oldestIdentity) break;
    rateLimitBuckets.delete(oldestIdentity);
  }
}

export function consumeBrowserLocationRequestQuota(
  rawIdentity: string,
  now = Date.now()
): BrowserLocationRateLimitResult {
  const identity = rawIdentity.trim().slice(0, 256) || "unknown";
  let bucket = rateLimitBuckets.get(identity);
  if (
    !bucket ||
    now - bucket.windowStartedAt >= BROWSER_LOCATION_RATE_LIMIT_WINDOW_MS
  ) {
    trimRateLimitBuckets(now);
    bucket = { count: 0, windowStartedAt: now };
    rateLimitBuckets.set(identity, bucket);
  } else {
    rateLimitBuckets.delete(identity);
    rateLimitBuckets.set(identity, bucket);
  }

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(
      (bucket.windowStartedAt + BROWSER_LOCATION_RATE_LIMIT_WINDOW_MS - now) /
        1_000
    )
  );
  if (bucket.count >= BROWSER_LOCATION_RATE_LIMIT_MAX_REQUESTS) {
    return Object.freeze({
      allowed: false,
      limit: BROWSER_LOCATION_RATE_LIMIT_MAX_REQUESTS,
      remaining: 0,
      retryAfterSeconds,
    });
  }

  bucket.count += 1;
  return Object.freeze({
    allowed: true,
    limit: BROWSER_LOCATION_RATE_LIMIT_MAX_REQUESTS,
    remaining: BROWSER_LOCATION_RATE_LIMIT_MAX_REQUESTS - bucket.count,
    retryAfterSeconds,
  });
}

export async function resolveBrowserLocation(input: {
  latitude: number;
  longitude: number;
  acceptLanguage?: string;
  signal?: AbortSignal;
}): Promise<BrowserLocationResult> {
  if (input.signal?.aborted) {
    throw new BrowserLocationRequestAbortedError();
  }
  const language = normalizeLanguage(input.acceptLanguage);
  const key = cacheKey(input.latitude, input.longitude, language);
  const cached = readCachedLocation(key);
  if (cached) return cached;

  const existing = inFlightLookups.get(key);
  if (existing) return subscribeToLookup(existing, input.signal);

  if (inFlightLookups.size >= BROWSER_LOCATION_MAX_PENDING_LOOKUPS) {
    throw new BrowserLocationCapacityError();
  }

  const controller = new AbortController();
  let entry!: InFlightLookup;
  const promise = fetchLocation(
    input.latitude,
    input.longitude,
    language,
    controller.signal
  )
    .then((value) => {
      writeCachedLocation(key, value);
      return value;
    })
    .finally(() => {
      entry.settled = true;
      if (inFlightLookups.get(key) === entry) inFlightLookups.delete(key);
    });
  entry = { controller, promise, settled: false, subscribers: 0 };
  inFlightLookups.set(key, entry);
  return subscribeToLookup(entry, input.signal);
}

export function resetBrowserLocationServiceForTests(): void {
  for (const entry of inFlightLookups.values()) entry.controller.abort();
  for (const task of providerTasks.splice(0)) {
    settleProviderTask(task);
    task.reject(new BrowserLocationRequestAbortedError());
  }
  locationCache.clear();
  inFlightLookups.clear();
  rateLimitBuckets.clear();
  nextProviderRequestAt = 0;
}
