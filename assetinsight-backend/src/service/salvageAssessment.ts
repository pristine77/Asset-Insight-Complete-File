import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { buildSalvageVehicleDetails, normalizeSalvageVehicleOverrides, validateSalvageVehicleOverrides, type SalvageVehicleDetails, type SalvageVehicleOverrides } from "./salvageVehicleDetails.js";

/** Server-owned, auditable assessment. Legacy snapshots without this object stay legacy. */
export const SALVAGE_ASSESSMENT_VERSION = 2 as const;
export type SalvageBasket = "pre_loss" | "as_is";
export type SalvagePriceBasis = "sold" | "asking" | "reserve" | "current_bid" | "unknown";
export interface SalvageReference {
  id: string;
  kind: "web" | "appraiser" | "photo";
  url: string | null;
  title: string;
  publisher: string | null;
  accessedAt: string | null;
  /** Saved source text, not an AI assertion that the URL was consulted. */
  excerpt: string;
  photoIds: string[];
}
export interface SalvageFieldEvidence { referenceId: string; quote: string }
export interface SalvageAdjustment {
  description: string;
  amount: number | null;
  referenceIds: string[];
  appraiserReason: string | null;
}
export interface SalvageComparableEvidence {
  id: string;
  basket: SalvageBasket;
  title: string;
  url: string | null;
  sourceName: string | null;
  listingId: string | null;
  vin: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  powertrain: string | null;
  odometer: number | null;
  odometerUnit: "km" | "mi" | null;
  condition: string | null;
  brand: string | null;
  location: string | null;
  province: string | null;
  country: string | null;
  eventDate: string | null;
  price: number | null;
  currency: string | null;
  priceBasis: SalvagePriceBasis;
  verification: "verified" | "unverified" | "appraiser_supplied";
  evidence: Record<string, SalvageFieldEvidence>;
  referenceIds: string[];
  adjustments: SalvageAdjustment[];
  fx: { cadPerUnit: number; date: string; referenceId: string } | null;
  appraiserReason: string | null;
  photoIds: string[];
  eligible: boolean;
  selected: boolean;
  exclusionReasons: string[];
  adjustedPrice: number | null;
  ageDays: number | null;
}
export interface SalvagePhotoFinding {
  photoId: string;
  status: "analyzed" | "not_analyzed";
  observations: string[];
  facts: { field: string; value: string | null; evidence: string; source: "observed" | "supplied" }[];
  uncertainties: string[];
}
export interface SalvageCostInput {
  description: string;
  amount: number | null;
  referenceIds: string[];
  appraiserReason: string | null;
}
export interface SalvageRepairItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  referenceIds: string[];
  appraiserReason: string | null;
}
export interface SalvageLabourItem {
  description: string;
  hours: number | null;
  rate: number | null;
  referenceIds: string[];
  appraiserReason: string | null;
}
export interface SalvageAssessmentInputs {
  /** Explicit appraiser corrections, kept separate from immutable photo evidence. */
  vehicleOverrides?: SalvageVehicleOverrides;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  powertrain: string | null;
  vin: string | null;
  odometer: number | null;
  odometerUnit: "km" | "mi" | null;
  province: string | null;
  market: string | null;
  effectiveDate: string | null;
  lossType: string | null;
  condition: string | null;
  damageDescription: string | null;
  documentedBrand: string | null;
  brandProvince: string | null;
  brandEvidenceRef: string | null;
  currency: "CAD";
  repairItems: SalvageRepairItem[];
  labourItems: SalvageLabourItem[];
  charges: SalvageCostInput[];
  /** Null means not established. Explicit, documented zero is valid. */
  sellerCosts: { fees: SalvageCostInput | null; transport: SalvageCostInput | null;
    storage: SalvageCostInput | null; disposal: SalvageCostInput | null };
  suppliedComparables: SalvageComparableEvidence[];
  suppliedReferences: SalvageReference[];
  overrides: { preLoss: SalvageCostInput | null; asIs: SalvageCostInput | null };
}
export interface SalvageValueConclusion {
  amount: number | null;
  low: number | null;
  high: number | null;
  currency: "CAD";
  priceBasis: "sold" | "asking" | null;
  status: "supported" | "provisional" | "insufficient_evidence" | "appraiser_override";
  comparableIds: string[];
  method: string;
  referenceIds: string[];
}
export interface SalvageLimitation {
  code: string;
  message: string;
  severity: "warning" | "critical";
  acknowledgementRequired: boolean;
}
export interface SalvageAssessmentV2 {
  schemaVersion: 2;
  generatedAt: string;
  inputs: SalvageAssessmentInputs;
  /** Inputs at the paid research run: never rewritten by preview edits. */
  researchedInputs: SalvageAssessmentInputs;
  stale: boolean;
  photoFindings: SalvagePhotoFinding[];
  /** Absent for legacy reports until explicitly researched again. */
  vehicleDetails?: SalvageVehicleDetails;
  candidates: SalvageComparableEvidence[];
  comparables: SalvageComparableEvidence[];
  references: SalvageReference[];
  valuations: { preLoss: SalvageValueConclusion; asIs: SalvageValueConclusion };
  repairs: {
    parts: (SalvageRepairItem & { total: number | null })[];
    labour: (SalvageLabourItem & { total: number | null })[];
    charges: SalvageCostInput[];
    partsTotal: number | null; labourTotal: number | null; chargesTotal: number | null;
    knownSubtotal: number; total: number | null; status: "complete" | "incomplete";
  };
  netRecovery: { gross: number | null; deductions: SalvageAssessmentInputs["sellerCosts"];
    knownDeductions: number; total: number | null; status: "complete" | "incomplete"; formula: string };
  limitations: SalvageLimitation[];
  research: Record<string, unknown>;
}
export interface BuildSalvageAssessmentOptions {
  inputs: unknown;
  photoFindings?: unknown[];
  candidates?: unknown[];
  references?: unknown[];
  warnings?: (string | SalvageLimitation)[];
  generatedAt?: string;
  research?: Record<string, unknown>;
  vehiclePhotoExtraction?: boolean;
}

type ObjectRecord = Record<string, unknown>;
const object = (value: unknown): ObjectRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectRecord : {};
const list = (value: unknown, maximum = 200): unknown[] => Array.isArray(value) ? value.slice(0, maximum) : [];
const string = (value: unknown, maximum = 2000): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).replace(/\u0000/g, "").trim().slice(0, maximum);
  return result || null;
};
const strings = (value: unknown, maximum = 100): string[] => [...new Set(list(value, maximum).map((item) => string(item)).filter((item): item is string => item !== null))];
const number = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  // Currency symbols, ambiguous decimal separators and NaN are not silently guessed.
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const result = Number(value);
  return Number.isFinite(result) && Math.abs(result) <= 1e12 ? result : null;
};
const positive = (value: unknown): number | null => { const n = number(value); return n !== null && n >= 0 ? n : null; };
const round = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const normalizedText = (value: unknown): string => (string(value, 100000) || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const stableId = (prefix: string, value: string): string => `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
const validPhotoId = (id: string): boolean => /^photo-\d{3}$/.test(id) && Number(id.slice(6)) >= 1 && Number(id.slice(6)) <= 50;
const PROVINCES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);
const PROVINCE_NAMES: Record<string, string> = { alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB", "newfoundland and labrador": "NL", "nova scotia": "NS", "northwest territories": "NT", nunavut: "NU", ontario: "ON", "prince edward island": "PE", quebec: "QC", québec: "QC", saskatchewan: "SK", yukon: "YT" };
function province(value: unknown): string | null {
  const result = string(value, 80);
  return result ? PROVINCE_NAMES[result.toLowerCase()] || (PROVINCES.has(result.toUpperCase()) ? result.toUpperCase() : null) : null;
}
function date(value: unknown): string | null {
  const result = string(value, 40);
  if (!result || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(result)) return null;
  const day = result.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}
const year = (value: unknown): number | null => { const y = number(value); return y !== null && Number.isInteger(y) && y >= 1886 && y <= 2100 ? y : null; };
const vin = (value: unknown): string | null => {
  const result = string(value, 40)?.replace(/[\s-]/g, "").toUpperCase();
  return result && /^[A-HJ-NPR-Z0-9]{17}$/.test(result) ? result : null;
};

/** URL validation is not a network permission: callers must also fence redirects/DNS before fetching. */
export function safeSalvageSourceUrl(value: unknown): string | null {
  const raw = string(value, 3000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    // Domain source citations do not need raw IPs. Reject all IP literals, including
    // IPv4-in-IPv6, hex/integer IPv4 accepted and canonicalized by URL parsing.
    if (isIP(host) || !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|home|lan)$/.test(host)
      || host === "metadata.google.internal" || /(?:^|\.)nip\.io$|(?:^|\.)sslip\.io$/.test(host)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return null; }
}

function normalizeReference(value: unknown): SalvageReference | null {
  const raw = object(value);
  const kind = raw.kind === "appraiser" || raw.kind === "photo" ? raw.kind : "web";
  const url = safeSalvageSourceUrl(raw.url);
  if (kind === "web" && !url) return null;
  const title = string(raw.title, 500) || "Untitled evidence";
  const excerpt = string(raw.excerpt, 60000) || "";
  const photoIds = strings(raw.photoIds, 50).filter(validPhotoId);
  const identifier = string(raw.id, 80);
  return {
    id: identifier && /^[A-Za-z][\w-]{0,79}$/.test(identifier) ? identifier : stableId("ref", `${kind}|${url || title}|${excerpt}|${photoIds.join(",")}`),
    kind, url, title, publisher: string(raw.publisher, 200), accessedAt: date(raw.accessedAt), excerpt, photoIds,
  };
}
function referenceSet(values: unknown[]): { references: SalvageReference[]; aliases: Map<string, string> } {
  const references: SalvageReference[] = [];
  const aliases = new Map<string, string>();
  const identities = new Map<string, SalvageReference>();
  const ids = new Set<string>();
  for (const value of values.slice(0, 100)) {
    const ref = normalizeReference(value);
    if (!ref) continue;
    const key = `${ref.kind}|${ref.url || ref.title}|${ref.kind === "web" ? "" : ref.excerpt}`;
    const prior = identities.get(key);
    if (prior) {
      if (!ids.has(ref.id)) aliases.set(ref.id, prior.id);
      // A second extraction from the same page may cover a different field.
      if (ref.excerpt && !prior.excerpt.includes(ref.excerpt)) prior.excerpt = `${prior.excerpt}\n${ref.excerpt}`.slice(0, 60000);
      continue;
    }
    if (ids.has(ref.id)) ref.id = stableId("ref", key);
    ids.add(ref.id); aliases.set(ref.id, ref.id); identities.set(key, ref); references.push(ref);
  }
  return { references, aliases };
}
function cost(value: unknown): SalvageCostInput | null {
  if (value === null || value === undefined) return null;
  const item = object(value);
  return { description: string(item.description ?? item.name) || "Unspecified cost", amount: positive(item.amount),
    referenceIds: strings(item.referenceIds), appraiserReason: string(item.appraiserReason, 6000) };
}
function repair(value: unknown): SalvageRepairItem {
  const item = object(value);
  return { description: string(item.description ?? item.name) || "Unspecified part", quantity: positive(item.quantity),
    unitPrice: positive(item.unitPrice ?? item.unit_price), referenceIds: strings(item.referenceIds), appraiserReason: string(item.appraiserReason, 6000) };
}
function labour(value: unknown): SalvageLabourItem {
  const item = object(value);
  return { description: string(item.description ?? item.task) || "Unspecified labour", hours: positive(item.hours),
    rate: positive(item.rate ?? item.rate_per_hour), referenceIds: strings(item.referenceIds), appraiserReason: string(item.appraiserReason, 6000) };
}
function normalizeCandidate(value: unknown, aliases = new Map<string, string>()): SalvageComparableEvidence {
  const raw = object(value);
  const url = safeSalvageSourceUrl(raw.url ?? raw.link);
  const candidateVin = vin(raw.vin);
  const listingId = string(raw.listingId, 160);
  const title = string(raw.title, 500) || "Unidentified comparable";
  const refIds = (input: unknown) => strings(input).map((id) => aliases.get(id) || id);
  const evidence: Record<string, SalvageFieldEvidence> = {};
  for (const [field, entry] of Object.entries(object(raw.evidence)).slice(0, 40)) {
    const item = object(entry), referenceId = string(item.referenceId, 80), quote = string(item.quote, 4000);
    if (referenceId && quote && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(field)) evidence[field] = { referenceId: aliases.get(referenceId) || referenceId, quote };
  }
  const basis = ["sold", "asking", "reserve", "current_bid"].includes(String(raw.priceBasis)) ? raw.priceBasis as SalvagePriceBasis : "unknown";
  const fx = object(raw.fx), rate = positive(fx.cadPerUnit), fxDate = date(fx.date), fxRef = string(fx.referenceId, 80);
  return {
    id: stableId("comp", candidateVin || `${url || normalizedText(raw.sourceName)}|${listingId || normalizedText(title)}`),
    basket: raw.basket === "pre_loss" ? "pre_loss" : "as_is", title, url,
    sourceName: string(raw.sourceName, 200), listingId, vin: candidateVin, year: year(raw.year),
    make: string(raw.make, 100), model: string(raw.model, 150), trim: string(raw.trim, 150), powertrain: string(raw.powertrain, 300),
    odometer: positive(raw.odometer), odometerUnit: raw.odometerUnit === "km" || raw.odometerUnit === "mi" ? raw.odometerUnit : null,
    condition: string(raw.condition, 3000), brand: string(raw.brand, 300), location: string(raw.location, 500), province: province(raw.province),
    country: string(raw.country, 80)?.toUpperCase() || null, eventDate: date(raw.eventDate),
    price: positive(raw.price), currency: /^[A-Z]{3}$/.test(String(raw.currency).toUpperCase()) ? String(raw.currency).toUpperCase() : null,
    priceBasis: basis, verification: raw.verification === "verified" || raw.verification === "appraiser_supplied" ? raw.verification : "unverified",
    evidence, referenceIds: [...new Set([...refIds(raw.referenceIds), ...Object.values(evidence).map((item) => item.referenceId)])],
    adjustments: list(raw.adjustments, 20).map((value) => { const adj = object(value); return { description: string(adj.description) || "Unspecified adjustment", amount: number(adj.amount), referenceIds: refIds(adj.referenceIds), appraiserReason: string(adj.appraiserReason, 6000) }; }),
    fx: rate !== null && rate > 0 && fxDate && fxRef ? { cadPerUnit: rate, date: fxDate, referenceId: aliases.get(fxRef) || fxRef } : null,
    appraiserReason: string(raw.appraiserReason, 6000), photoIds: strings(raw.photoIds, 50).filter(validPhotoId),
    eligible: false, selected: false, exclusionReasons: [], adjustedPrice: null, ageDays: null,
  };
}

/** Allowlisted normalization: unknown properties/provider provenance cannot enter via preview inputs. */
export function normalizeSalvageAssessmentInputs(value: unknown): SalvageAssessmentInputs {
  const raw = object(value), nested = object(raw.assessment_inputs);
  const input = { ...raw, ...nested };
  const sellers = object(input.sellerCosts), overrides = object(input.overrides);
  // These inputs are owner-editable, not provider attestations. A supplied URL
  // must never let its author promote an assertion to independently verified web evidence.
  const supplied = referenceSet(list(input.suppliedReferences, 50).map((value) => {
    const ref = object(value); return { ...ref, kind: ref.kind === "photo" ? "photo" : "appraiser" };
  }));
  return {
    ...(Object.prototype.hasOwnProperty.call(input, "vehicleOverrides") ? { vehicleOverrides: normalizeSalvageVehicleOverrides(input.vehicleOverrides) } : {}),
    year: year(input.year), make: string(input.make, 100), model: string(input.model ?? input.item_model, 150),
    trim: string(input.trim, 150), powertrain: string(input.powertrain, 300), vin: vin(input.vin),
    odometer: positive(input.odometer), odometerUnit: input.odometerUnit === "km" || input.odometerUnit === "mi" ? input.odometerUnit : null,
    province: province(input.province), market: string(input.market, 500), effectiveDate: date(input.effectiveDate ?? input.effective_date),
    lossType: string(input.lossType ?? input.loss_type ?? input.reported_loss_type, 1000),
    condition: string(input.condition ?? input.item_condition, 4000), damageDescription: string(input.damageDescription ?? input.damage_description, 8000),
    documentedBrand: string(input.documentedBrand ?? input.documented_brand, 300), brandProvince: province(input.brandProvince),
    brandEvidenceRef: string(input.brandEvidenceRef, 80), currency: "CAD",
    repairItems: list(input.repairItems ?? input.repair_items, 300).map(repair),
    labourItems: list(input.labourItems ?? input.labour_breakdown, 300).map(labour),
    charges: list(input.charges, 50).map(cost).filter((item): item is SalvageCostInput => item !== null),
    sellerCosts: { fees: cost(sellers.fees), transport: cost(sellers.transport), storage: cost(sellers.storage), disposal: cost(sellers.disposal) },
    suppliedComparables: list(input.suppliedComparables, 20).map((item) => normalizeCandidate({ ...object(item), verification: "appraiser_supplied" }, supplied.aliases)),
    suppliedReferences: supplied.references,
    overrides: { preLoss: cost(overrides.preLoss), asIs: cost(overrides.asIs) },
  };
}

/** Validate explicit edits before normalization so invalid numbers are not silently saved as unknown. */
export function validateSalvageAssessmentInputs(value: unknown): { valid: boolean; errors: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Assessment inputs must be an object"] };
  const raw = object(value), errors: string[] = [];
  if (Object.prototype.hasOwnProperty.call(raw, "vehicleOverrides")) errors.push(...validateSalvageVehicleOverrides(raw.vehicleOverrides).errors);
  const present = (item: unknown) => item !== null && item !== undefined && item !== "";
  const numeric = (item: unknown, path: string) => { if (present(item) && positive(item) === null) errors.push(`${path} must be a finite non-negative number or null`); };
  numeric(raw.odometer, "odometer");
  if (present(raw.year) && year(raw.year) === null) errors.push("year must be a valid vehicle year or null");
  if (present(raw.effectiveDate) && !date(raw.effectiveDate)) errors.push("effectiveDate must be a valid ISO date or null");
  if (present(raw.province) && !province(raw.province)) errors.push("province must be a Canadian province/territory code or null");
  if (present(raw.odometerUnit) && !["km", "mi"].includes(String(raw.odometerUnit))) errors.push("odometerUnit must be km, mi or null");
  const groups: [string, number, string[]][] = [["repairItems", 300, ["quantity", "unitPrice"]], ["labourItems", 300, ["hours", "rate"]], ["charges", 50, ["amount"]], ["suppliedComparables", 20, ["price", "odometer"]], ["suppliedReferences", 50, []]];
  for (const [key, maximum, fields] of groups) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) { errors.push(`${key} must be an array`); continue; }
    if (Array.isArray(raw[key]) && raw[key].length > maximum) errors.push(`${key} exceeds ${maximum} entries`);
    list(raw[key], maximum).forEach((value, index) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) errors.push(`${key}[${index}] must be an object`);
      for (const field of fields) numeric(object(value)[field], `${key}[${index}].${field}`);
    });
  }
  for (const [key, value] of Object.entries(object(raw.sellerCosts))) numeric(object(value).amount, `sellerCosts.${key}.amount`);
  for (const [key, value] of Object.entries(object(raw.overrides))) numeric(object(value).amount, `overrides.${key}.amount`);
  return { valid: errors.length === 0, errors };
}

function normalizePhotos(values: unknown[]): SalvagePhotoFinding[] {
  const seen = new Set<string>();
  return values.slice(0, 50).flatMap((value) => {
    const raw = object(value), photoId = string(raw.photoId, 40);
    if (!photoId || !validPhotoId(photoId) || seen.has(photoId)) return [];
    seen.add(photoId);
    const analyzed = raw.status === "analyzed";
    return [{ photoId, status: analyzed ? "analyzed" as const : "not_analyzed" as const,
      observations: analyzed ? strings(raw.observations, 100) : [],
      facts: analyzed ? list(raw.facts, 100).map((value) => { const fact = object(value); return { field: string(fact.field, 100) || "unknown", value: string(fact.value), evidence: string(fact.evidence, 4000) || "", source: fact.source === "supplied" ? "supplied" as const : "observed" as const }; }).filter((fact) => fact.source === "supplied" || fact.evidence.length > 0) : [],
      uncertainties: strings(raw.uncertainties, 100),
    }];
  });
}

function hasEvidence(candidate: SalvageComparableEvidence, field: string, refs: Map<string, SalvageReference>): boolean {
  const item = candidate.evidence[field];
  if (!item) return false;
  const ref = refs.get(item.referenceId);
  if (!ref || !ref.excerpt || !ref.accessedAt) return false;
  const quote = normalizedText(item.quote), source = normalizedText(ref.excerpt);
  if (quote.length < 3 || !source.includes(quote)) return false;
  const value = candidate[field as keyof SalvageComparableEvidence];
  if (field === "price" || field === "odometer") {
    // A fetched page mentioning a number does not support a different model price.
    const numbers = (item.quote.match(/\d[\d, ]*(?:\.\d{1,2})?/g) || []).map((entry) => Number(entry.replace(/[, ]/g, "")));
    return typeof value === "number" && numbers.includes(value);
  }
  if (["year", "make", "model", "condition", "brand", "location"].includes(field)) return value !== null && quote.includes(normalizedText(value));
  if (field === "currency") {
    const rawQuote = item.quote.toUpperCase();
    return candidate.currency === "CAD" ? /\bCAD\b|CA\$|C\$|CANADIAN DOLLARS|DOLLARS CANADIENS/.test(rawQuote)
      : candidate.currency === "USD" ? /\bUSD\b|US\$|US DOLLARS/.test(rawQuote)
      : Boolean(candidate.currency && new RegExp(`\\b${candidate.currency}\\b`).test(rawQuote));
  }
  if (field === "priceBasis") return candidate.priceBasis === "sold" ? !/\b(not sold|unsold|sale pending|if bid|subject to seller approval|not awarded|non vendu)\b/.test(quote) && /\b(sold|sale completed|awarded|vendu|vendue)\b/.test(quote)
    : candidate.priceBasis === "asking" ? /\b(asking|for sale|advertised|listed)\b|à vendre|prix demandé|precio solicitado|en venta/.test(quote) : false;
  if (field === "eventDate") {
    const iso = candidate.eventDate;
    if (!iso) return false;
    if (item.quote.includes(iso)) return true;
    const day = new Date(`${iso}T00:00:00Z`);
    const months = ["en-CA", "fr-CA", "es-ES"].flatMap((locale) => ["long", "short"].map((month) => normalizedText(new Intl.DateTimeFormat(locale, { month: month as "long" | "short", timeZone: "UTC" }).format(day))));
    return months.some((month) => quote.includes(month)) && new RegExp(`\\b${day.getUTCDate()}\\b`).test(quote) && quote.includes(String(day.getUTCFullYear()));
  }
  return true;
}
const reasoned = (reason: string | null): boolean => Boolean(reason && reason.trim().length >= 10);
function cadAmounts(text: string): number[] {
  const results: number[] = [];
  for (const match of text.matchAll(/(?:\bCAD\b|CA\$|C\$)\s*(-?\d[\d,]*(?:\.\d+)?)|(-?\d[\d,]*(?:\.\d+)?)\s*\bCAD\b/gi)) {
    const value = Number((match[1] || match[2]).replace(/,/g, ""));
    if (Number.isFinite(value)) results.push(value);
  }
  return results;
}
function referenceProof(referenceIds: string[], refs: Map<string, SalvageReference>, test: (excerpt: string) => boolean): boolean {
  return referenceIds.some((id) => { const ref = refs.get(id); return ref?.kind === "web" && ref.excerpt.length > 0 && ref.accessedAt !== null && test(ref.excerpt); });
}
function amountSupported(referenceIds: string[], reason: string | null, refs: Map<string, SalvageReference>, amount: number | null, description: string, adjustment = false): boolean {
  if (amount === null || !referenceIds.every((id) => refs.has(id))) return false;
  return reasoned(reason) || referenceProof(referenceIds, refs, (excerpt) => {
    // Citing an unrelated page is not evidence of this cost. Require the exact
    // CAD amount plus the line's identity and (for adjustments) adjustment context.
    const amounts = cadAmounts(excerpt), normalized = normalizedText(excerpt), identity = normalizedText(description);
    return identity.length > 2 && normalized.includes(identity) && amounts.includes(amount)
      && (!adjustment || /\b(adjustment|deduction|discount|premium|ajustement|déduction)\b/.test(normalized));
  });
}
function labelledNumber(excerpt: string, value: number, labels: string): boolean {
  const escaped = String(value).replace(/\./g, "\\.");
  return new RegExp(`(?:\\b(?:${labels})\\s*[:=]?\\s*${escaped}\\b|\\b${escaped}\\s*(?:${labels})\\b)`, "i").test(excerpt);
}
function sumNullable(values: (number | null)[]): number | null {
  return values.length > 0 && values.every((value) => value !== null) ? round(values.reduce<number>((sum, value) => sum + (value || 0), 0)) : null;
}
function calculateRepairs(inputs: SalvageAssessmentInputs, refs: Map<string, SalvageReference>): SalvageAssessmentV2["repairs"] {
  const parts = inputs.repairItems.map((item) => ({ ...item, total: item.quantity !== null && item.unitPrice !== null
    && item.referenceIds.every((id) => refs.has(id))
    && (reasoned(item.appraiserReason) || referenceProof(item.referenceIds, refs, (excerpt) => cadAmounts(excerpt).includes(item.unitPrice!)
      && normalizedText(excerpt).includes(normalizedText(item.description)) && labelledNumber(excerpt, item.quantity!, "quantity|qty|units|pieces|quantité"))) ? round(item.quantity * item.unitPrice) : null }));
  const labour = inputs.labourItems.map((item) => ({ ...item, total: item.hours !== null && item.rate !== null
    && item.referenceIds.every((id) => refs.has(id))
    && (reasoned(item.appraiserReason) || referenceProof(item.referenceIds, refs, (excerpt) => cadAmounts(excerpt).includes(item.rate!)
      && /per hour|\/hr|hourly|l heure|heure/i.test(excerpt) && normalizedText(excerpt).includes(normalizedText(item.description))
      && labelledNumber(excerpt, item.hours!, "hours|hrs|heures"))) ? round(item.hours * item.rate) : null }));
  const charges = inputs.charges.map((item) => ({ ...item, amount: amountSupported(item.referenceIds, item.appraiserReason, refs, item.amount, item.description) ? item.amount : null }));
  const partsTotal = sumNullable(parts.map((item) => item.total)), labourTotal = sumNullable(labour.map((item) => item.total)), chargesTotal = sumNullable(charges.map((item) => item.amount));
  const total = sumNullable([partsTotal, labourTotal, chargesTotal]);
  return { parts, labour, charges, partsTotal, labourTotal, chargesTotal,
    knownSubtotal: round([...parts.map((item) => item.total), ...labour.map((item) => item.total), ...charges.map((item) => item.amount)].reduce<number>((sum, value) => sum + (value || 0), 0)),
    total, status: total === null ? "incomplete" : "complete" };
}
function calculateValue(candidates: SalvageComparableEvidence[], basket: SalvageBasket, override: SalvageCostInput | null, refs: Map<string, SalvageReference>): SalvageValueConclusion {
  const eligible = candidates.filter((item) => item.basket === basket && item.eligible);
  const sold = eligible.filter((item) => item.priceBasis === "sold"), asking = eligible.filter((item) => item.priceBasis === "asking");
  const selection = (sold.length >= 3 ? sold : asking.length >= 3 ? asking : sold.length >= asking.length ? sold : asking).slice(0, 6);
  for (const item of selection) item.selected = true;
  const base: SalvageValueConclusion = { amount: null, low: null, high: null, currency: "CAD", priceBasis: selection[0]?.priceBasis === "sold" ? "sold" : selection[0]?.priceBasis === "asking" ? "asking" : null,
    status: "insufficient_evidence", comparableIds: selection.map((item) => item.id), method: "At least three eligible distinct vehicles of the same price basis are required. Observed range is not a statistical confidence interval.", referenceIds: [...new Set(selection.flatMap((item) => item.referenceIds))] };
  if (override && override.amount !== null && amountSupported(override.referenceIds, override.appraiserReason, refs, override.amount, override.description)) {
    return { ...base, amount: round(override.amount), status: "appraiser_override", method: `Appraiser override: ${override.appraiserReason || override.description}`, referenceIds: [...new Set([...base.referenceIds, ...override.referenceIds])] };
  }
  if (selection.length < 3) return base;
  const prices = selection.map((item) => item.adjustedPrice as number).sort((a, b) => a - b);
  const middle = Math.floor(prices.length / 2), median = prices.length % 2 ? prices[middle] : (prices[middle - 1] + prices[middle]) / 2;
  return { ...base, amount: round(median), low: prices[0], high: prices[prices.length - 1],
    status: base.priceBasis === "asking" ? "provisional" : "supported", method: `${base.priceBasis === "asking" ? "Provisional asking-market" : "Verified-sale"} median of ${prices.length} eligible distinct vehicles. Range is the observed minimum–maximum, not a confidence interval.` };
}

/** These are explicit textual contradictions, not an inference of damage or legal brand from photos. */
function conditionSignals(value: unknown): { damaged: boolean; undamaged: boolean } {
  const text = normalizedText(value);
  const clear = /\b(?:undamaged|accident free|normal wear(?: and tear)?|no (?:visible |reported |known )?(?:damage|accidents)|without damage|sans dommages?|aucun dommage|sin daños)\b/.test(text);
  // Remove only the negated/repaired phrase. A later clause such as "but flood
  // damage" must still be visible; a whole-description negative match is unsafe.
  const current = text
    .replace(/\b(?:no|without|not)(?: (?:visible|reported|known|structural|body|frame|collision|fire|flood|mechanical)){0,3} (?:damage|damages|accidents|defects)\b/g, " ")
    .replace(/\b(?:sans|aucun|aucuns|aucune|aucunes) dommages?\b|\bsin daños\b/g, " ")
    .replace(/\b(?:fully |properly |previously )?repaired (?:collision |accident |body |structural |flood |fire )?(?:damage|damages)\b/g, " ")
    .replace(/\b(?:collision |accident |body |structural |flood |fire )?damage (?:has been |was |is )?(?:fully |properly )?repaired\b/g, " ");
  return { damaged: /\b(?:damage|damaged|collision|flooded|burned|burnt|wrecked|unrepaired|parts only|engine seized|non running|inoperable|dommages|endommagé|endommagée|inondé|incendié|daños|averiado)\b/.test(current), undamaged: clear };
}
function statedBrand(value: unknown): "normal" | "salvage" | "irreparable" | "rebuilt" | null {
  const text = normalizedText(value);
  if (/^(?:normal|none|clean|clean title|clear title|unbranded|non branded)$/.test(text)) return "normal";
  if (/^(?:salvage|salvage title|salvage brand|récupération|recuperation)$/.test(text)) return "salvage";
  if (/^(?:irreparable|irréparable|non repairable|nonrepairable|parts only|junk)$/.test(text)) return "irreparable";
  if (/^(?:rebuilt|rebuilt title|reconstructed|reconstruit|reconstruite)$/.test(text)) return "rebuilt";
  return null;
}
function mileageGap(candidate: SalvageComparableEvidence, input: SalvageAssessmentInputs): boolean {
  if (candidate.odometer === null || !candidate.odometerUnit || input.odometer === null || !input.odometerUnit) return false;
  const subjectKm = input.odometer * (input.odometerUnit === "mi" ? 1.609344 : 1);
  const candidateKm = candidate.odometer * (candidate.odometerUnit === "mi" ? 1.609344 : 1);
  // Conservative product selection policy, NOT a Canadian appraisal standard.
  return Math.abs(subjectKm - candidateKm) > Math.max(50000, subjectKm * 0.3);
}
function evaluateCandidate(candidate: SalvageComparableEvidence, input: SalvageAssessmentInputs, refs: Map<string, SalvageReference>): SalvageComparableEvidence {
  const exclusions: string[] = [];
  const manual = candidate.verification === "appraiser_supplied" && Boolean(candidate.appraiserReason && candidate.appraiserReason.length >= 10)
    && candidate.referenceIds.some((id) => refs.get(id)?.kind === "appraiser" || refs.get(id)?.kind === "photo");
  if (!manual && candidate.verification !== "verified") exclusions.push("Unverified source content");
  if (!candidate.referenceIds.every((id) => refs.has(id))) exclusions.push("Unresolved evidence reference");
  if (!candidate.url && !manual) exclusions.push("Missing or unsafe source URL");
  if (candidate.url && !manual && !candidate.referenceIds.some((id) => refs.get(id)?.url === candidate.url)) exclusions.push("Source URL is not linked to saved evidence");
  if (candidate.price === null || candidate.price <= 0) exclusions.push("Missing supported positive price");
  if (candidate.priceBasis !== "sold" && candidate.priceBasis !== "asking") exclusions.push("Reserve, current bid or unknown price basis is not a realized/asking value");
  if (candidate.year === null || !candidate.make || !candidate.model || !candidate.condition || candidate.odometer === null || !candidate.odometerUnit) exclusions.push("Missing critical vehicle specification, mileage or condition");
  if (!candidate.country || !candidate.location) exclusions.push("Missing market location");
  if (input.year === null || !input.make || !input.model || input.odometer === null || !input.odometerUnit || !input.province || !input.market || !input.effectiveDate) exclusions.push("Subject identity, mileage, Canadian market or valuation date incomplete");
  if (input.make && candidate.make && normalizedText(input.make) !== normalizedText(candidate.make)) exclusions.push("Different make requires professional selection outside automatic valuation");
  if (input.model && candidate.model && normalizedText(input.model) !== normalizedText(candidate.model)) exclusions.push("Different model requires professional selection outside automatic valuation");
  if (input.year && candidate.year && Math.abs(input.year - candidate.year) > 2 && !candidate.adjustments.length && !reasoned(candidate.appraiserReason)) exclusions.push("Material year difference requires supported adjustment or appraiser rationale");
  if (input.trim && candidate.trim && normalizedText(input.trim) !== normalizedText(candidate.trim) && !candidate.adjustments.length && !reasoned(candidate.appraiserReason)) exclusions.push("Trim difference requires supported adjustment or appraiser rationale");
  if (input.powertrain && candidate.powertrain && normalizedText(input.powertrain) !== normalizedText(candidate.powertrain) && !candidate.adjustments.length && !reasoned(candidate.appraiserReason)) exclusions.push("Powertrain difference requires supported adjustment or appraiser rationale");
  if (input.trim && !candidate.trim && !reasoned(candidate.appraiserReason)) exclusions.push("Unknown comparable trim cannot match a known subject trim without appraiser rationale");
  if (input.powertrain && !candidate.powertrain && !reasoned(candidate.appraiserReason)) exclusions.push("Unknown comparable powertrain cannot match a known subject powertrain without appraiser rationale");
  const condition = conditionSignals(candidate.condition), subjectCondition = conditionSignals(`${input.condition || ""}; ${input.damageDescription || ""}; ${input.lossType || ""}`);
  const candidateBrand = statedBrand(candidate.brand), subjectBrand = statedBrand(input.documentedBrand);
  if (!reasoned(candidate.appraiserReason)) {
    if (candidate.basket === "pre_loss" && (condition.damaged || candidateBrand === "salvage" || candidateBrand === "irreparable")) exclusions.push("Pre-loss basket contains explicit unrepaired damage or a salvage/irreparable listing brand; appraiser rationale is required");
    if (candidate.basket === "as_is" && subjectCondition.damaged && condition.undamaged && !condition.damaged) exclusions.push("Undamaged comparable conflicts with the damaged as-is subject; appraiser rationale is required");
    // A post-loss salvage brand does not establish the subject's pre-loss brand.
    // Compare as-is brands, or known normal/rebuilt pre-loss context, only.
    if (candidateBrand && subjectBrand && candidateBrand !== subjectBrand && (candidate.basket === "as_is" || ["normal", "rebuilt"].includes(subjectBrand))) exclusions.push("Stated comparable brand conflicts with the supplied subject brand; appraiser rationale is required, without certifying either brand");
    const supportedMileageAdjustment = candidate.adjustments.some((adjustment) => /\b(?:mileage|odometer|kilometres?|kilometers?|kilométrage|kilometrage)\b/.test(normalizedText(adjustment.description))
      && amountSupported(adjustment.referenceIds, adjustment.appraiserReason, refs, adjustment.amount, adjustment.description, true));
    if (mileageGap(candidate, input) && !supportedMileageAdjustment) exclusions.push("Mileage difference exceeds conservative automatic-selection policy (greater of 50,000 km or 30% of subject mileage); a supported mileage adjustment or appraiser rationale is required");
  }
  if (!manual) for (const field of ["price", "priceBasis", "currency", "year", "make", "model", "condition", "eventDate", "odometer", "location"]) {
    if (!hasEvidence(candidate, field, refs)) exclusions.push(`Missing verified ${field} evidence`);
  }
  if (!manual && candidate.brand && !hasEvidence(candidate, "brand", refs)) exclusions.push("Missing verified brand evidence");
  if (candidate.eventDate && input.effectiveDate) candidate.ageDays = Math.round((new Date(input.effectiveDate).getTime() - new Date(candidate.eventDate).getTime()) / 86400000);
  if (candidate.ageDays === null || candidate.ageDays < 0 || candidate.ageDays > 365) exclusions.push("Evidence must be dated on/before valuation date and no older than one year");
  let converted = candidate.price;
  if (candidate.currency !== "CAD") {
    const fxRef = candidate.fx && refs.get(candidate.fx.referenceId);
    const fxUrl = fxRef?.url && new URL(fxRef.url);
    let observationMatches = false;
    if (candidate.fx && fxRef?.kind === "web" && fxRef.excerpt) try {
      const observation = object(JSON.parse(fxRef.excerpt));
      observationMatches = observation.d === candidate.fx.date && positive(object(observation[`FX${candidate.currency}CAD`]).v) === candidate.fx.cadPerUnit;
    } catch { /* Unstructured or unverified conversion evidence is not a rate. */ }
    const fxAge = candidate.fx && input.effectiveDate ? (new Date(input.effectiveDate).getTime() - new Date(candidate.fx.date).getTime()) / 86400000 : null;
    if (!candidate.currency || !candidate.fx || !observationMatches || !fxUrl || !(fxUrl.hostname === "bankofcanada.ca" || fxUrl.hostname.endsWith(".bankofcanada.ca")) || fxAge === null || fxAge < 0 || fxAge > 7) {
      exclusions.push("Missing dated Bank of Canada conversion evidence"); converted = null;
    } else if (converted !== null) converted = round(converted * candidate.fx.cadPerUnit);
  }
  let adjustmentTotal = 0;
  for (const adjustment of candidate.adjustments) {
    if (adjustment.amount === null || !amountSupported(adjustment.referenceIds, adjustment.appraiserReason, refs, adjustment.amount, adjustment.description, true)) exclusions.push("Unsupported adjustment");
    else adjustmentTotal += adjustment.amount;
  }
  if (converted !== null) {
    candidate.adjustedPrice = round(converted + adjustmentTotal);
    if (candidate.adjustedPrice <= 0) exclusions.push("Adjusted price must be positive");
  }
  candidate.exclusionReasons = [...new Set(exclusions)];
  candidate.eligible = candidate.exclusionReasons.length === 0 && candidate.adjustedPrice !== null;
  return candidate;
}

function duplicateKeys(item: SalvageComparableEvidence): string[] {
  const keys: string[] = [];
  if (item.vin) keys.push(`vin:${item.vin}`);
  if (item.url) keys.push(`url:${item.url}`);
  if (item.listingId) keys.push(`listing:${normalizedText(item.sourceName) || (item.url ? new URL(item.url).hostname.replace(/^www\./, "") : "unknown")}:${normalizedText(item.listingId)}`);
  // Syndicated records without a VIN are conservatively one vehicle only when
  // specification, odometer and original price all match, not title alone.
  if (item.year && item.make && item.model && item.odometer !== null && item.price !== null) keys.push(`vehicle:${item.year}|${normalizedText(item.make)}|${normalizedText(item.model)}|${normalizedText(item.trim)}|${item.odometer}|${item.odometerUnit}|${item.price}|${item.currency}`);
  return keys;
}
function candidateScore(item: SalvageComparableEvidence, input: SalvageAssessmentInputs): number {
  return (item.eligible ? 10000 : 0) + (item.priceBasis === "sold" ? 1000 : 0) + (item.province && item.province === input.province ? 300 : 0)
    + (["CA", "CANADA"].includes(item.country || "") ? 100 : 0) + (item.ageDays !== null && item.ageDays <= 90 ? 50 : 0)
    - (item.ageDays || 0) / 1000 - (item.year && input.year ? Math.abs(item.year - input.year) : 20);
}

/** Use the same effective vehicle identity for research, preview and all exports. */
export function applySalvageVehicleDetails(inputs: SalvageAssessmentInputs, details: SalvageVehicleDetails): SalvageAssessmentInputs {
  const values = new Map(details.fields.map(field => [field.key, field.value]));
  return normalizeSalvageAssessmentInputs({ ...inputs, ...Object.fromEntries(
    ["year", "make", "model", "trim", "powertrain", "vin", "odometer", "odometerUnit"].map(key => [key, values.get(key) ?? null])) });
}

/** All arithmetic is deterministic; no provider-generated headline number is trusted. */
export function buildSalvageAssessment(options: BuildSalvageAssessmentOptions): SalvageAssessmentV2 {
  let inputs = normalizeSalvageAssessmentInputs(options.inputs);
  const photoFindings = normalizePhotos(options.photoFindings || []);
  const availablePhotos = new Set(photoFindings.map((photo) => photo.photoId));
  const vehicleDetails = options.vehiclePhotoExtraction ? buildSalvageVehicleDetails({ photoFindings,
    photoIds: [...availablePhotos], overrides: inputs.vehicleOverrides }) : undefined;
  if (vehicleDetails) inputs = applySalvageVehicleDetails(inputs, vehicleDetails);
  const normalizedReferences = referenceSet([...(options.references || []), ...inputs.suppliedReferences]);
  const aliases = normalizedReferences.aliases;
  const invalidPhotoReferences = normalizedReferences.references.filter((reference) => reference.photoIds.some((id) => !availablePhotos.has(id)) || reference.kind === "photo" && !reference.photoIds.length);
  const invalidRefIds = new Set(invalidPhotoReferences.map((reference) => reference.id));
  const references = normalizedReferences.references.filter((reference) => !invalidRefIds.has(reference.id));
  const refs = new Map(references.map((ref) => [ref.id, ref]));
  const candidates = [...inputs.suppliedComparables, ...(options.candidates || [])].slice(0, 20)
    .map((candidate) => evaluateCandidate(normalizeCandidate(candidate, aliases), inputs, refs));
  let invalidCandidatePhotos = false;
  for (const candidate of candidates) if (candidate.photoIds.some((id) => !availablePhotos.has(id))) {
    invalidCandidatePhotos = true;
    candidate.photoIds = candidate.photoIds.filter((id) => availablePhotos.has(id));
    candidate.eligible = false;
    candidate.exclusionReasons.push("Referenced photo is not present in this report");
  }
  candidates.sort((left, right) => candidateScore(right, inputs) - candidateScore(left, inputs) || left.id.localeCompare(right.id));
  // Resolve the whole identity graph first: a VIN duplicate can connect to a
  // syndicated record by listing ID and a third by fingerprint. Greedy dedup
  // misses these transitive relationships when rows arrive in another order.
  const parents = candidates.map((_, index) => index);
  const find = (index: number): number => { while (parents[index] !== index) index = parents[index]; return index; };
  const identities = new Map<string, number>();
  candidates.forEach((item, index) => {
    for (const key of duplicateKeys(item)) {
      const previous = identities.get(key);
      if (previous !== undefined) { const left = find(index), right = find(previous); parents[Math.max(left, right)] = Math.min(left, right); }
      identities.set(key, index);
    }
  });
  candidates.forEach((item, index) => {
    const first = find(index);
    if (first !== index) { item.eligible = false; item.exclusionReasons.push(`Duplicate vehicle/listing: ${candidates[first].id}`); }
  });
  // Distinct row IDs are required even for rejected duplicate candidates.
  const rowIds = new Set<string>();
  for (const item of candidates) { if (rowIds.has(item.id)) item.id = stableId("comp", `${item.id}|${rowIds.size}`); rowIds.add(item.id); }
  const valuations = { preLoss: calculateValue(candidates, "pre_loss", inputs.overrides.preLoss, refs), asIs: calculateValue(candidates, "as_is", inputs.overrides.asIs, refs) };
  const comparables = candidates.filter((item) => item.selected);
  const repairs = calculateRepairs(inputs, refs);
  const deductions = Object.fromEntries(Object.entries(inputs.sellerCosts).map(([key, value]) => [key, value && { ...value, amount: amountSupported(value.referenceIds, value.appraiserReason, refs, value.amount, value.description) ? value.amount : null }])) as SalvageAssessmentInputs["sellerCosts"];
  const costs = Object.values(deductions).map((item) => item?.amount ?? null);
  const allCosts = sumNullable(costs), gross = valuations.asIs.amount;
  const net = gross !== null && allCosts !== null ? round(gross - allCosts) : null;
  const limitations: SalvageLimitation[] = [];
  const add = (code: string, message: string, severity: SalvageLimitation["severity"] = "warning", acknowledgementRequired = true) => limitations.push({ code, message, severity, acknowledgementRequired });
  if (!inputs.vin) add("SUBJECT_VIN_UNVERIFIED", "VIN is absent or unreadable; identity requires appraiser verification.");
  if (!inputs.province || !inputs.market || !inputs.effectiveDate) add("SUBJECT_MARKET_INCOMPLETE", "Canadian province, market and effective valuation date are required for automatic valuation.", "critical");
  if (!inputs.year || !inputs.make || !inputs.model) add("SUBJECT_IDENTITY_INCOMPLETE", "Vehicle year, make and model have not been established.", "critical");
  if (inputs.odometer === null || !inputs.odometerUnit) add("SUBJECT_ODOMETER_UNVERIFIED", "Subject mileage and unit have not been established; automatic comparison is unavailable.");
  const brandRefId = inputs.brandEvidenceRef ? aliases.get(inputs.brandEvidenceRef) || inputs.brandEvidenceRef : null;
  const brandRef = brandRefId ? refs.get(brandRefId) : null;
  const suppliedBrandReference = brandRefId && inputs.suppliedReferences.some((reference) => (aliases.get(reference.id) || reference.id) === brandRefId);
  const brandText = normalizedText(brandRef?.excerpt), brandTitle = normalizedText(brandRef?.title);
  const provinceNames = Object.entries(PROVINCE_NAMES).filter(([, code]) => code === inputs.brandProvince).map(([name]) => name);
  const brandProvinceMatches = inputs.brandProvince && (new RegExp(`\\b${inputs.brandProvince.toLowerCase()}\\b`).test(brandText) || provinceNames.some((name) => brandText.includes(name)));
  const documentedBrandVerified = Boolean(inputs.documentedBrand && inputs.brandProvince && inputs.vin && suppliedBrandReference && brandRef
    && brandRef.kind !== "web" && (brandRef.photoIds.some((id) => availablePhotos.has(id)) || brandRef.url)
    && /registration|ownership|brand document|title|immatriculation|certificat|document de marque/.test(brandTitle)
    && brandText.includes(normalizedText(inputs.documentedBrand)) && brandText.includes(normalizedText(inputs.vin)) && brandProvinceMatches);
  if (!documentedBrandVerified) add("LEGAL_BRAND_UNVERIFIED", "Legal vehicle brand has not been verified against an appraiser-supplied vehicle-specific registration/brand document for the applicable province; generic provincial guidance and photo findings do not assign a brand.");
  for (const [key, value] of Object.entries(valuations)) {
    const prefix = key === "preLoss" ? "PRE_LOSS" : "AS_IS";
    if (value.status === "insufficient_evidence") add(`${prefix}_INSUFFICIENT_COMPARABLES`, "At least three eligible distinct comparables with a common price basis are unavailable; no automatic value is concluded.", "critical");
    if (value.status === "provisional") add(`${prefix}_ASKING_ONLY`, "This value reflects advertised asking prices, not verified completed sales.");
    if (value.status === "appraiser_override") add(`${prefix}_APPRAISER_OVERRIDE`, "The conclusion includes a separately documented appraiser override.");
  }
  if (repairs.total === null) add("REPAIR_ESTIMATE_INCOMPLETE", "Parts, labour or other charges lack complete supported inputs. Known subtotal is not a complete repair estimate.");
  if (net === null) add("NET_RECOVERY_INCOMPLETE", "Gross recovery or documented seller-side fees, transport, storage and disposal costs are incomplete; no definitive net recovery is available.");
  if (comparables.some((item) => item.ageDays !== null && item.ageDays > 90)) add("EXPANDED_EVIDENCE_DATES", "Selected evidence includes listings older than 90 days; no automatic time adjustment was invented.");
  if (comparables.some((item) => item.province !== inputs.province)) add("EXPANDED_GEOGRAPHY", "Selected evidence includes markets outside the subject province; geographic differences require professional review.");
  if (comparables.some((item) => !["CA", "CANADA"].includes(item.country || ""))) add("FOREIGN_MARKET_EVIDENCE", "Foreign-market evidence is included with any documented CAD conversion; currency conversion does not establish Canadian-market comparability.");
  if (comparables.some((item) => item.fx && item.fx.date !== inputs.effectiveDate)) add("PRIOR_DATE_FX_OBSERVATION", "A Bank of Canada daily rate from before the valuation date was used because no exact-date observation was available. Each comparable records the actual rate date (within seven days).");
  if (comparables.some((item) => item.verification === "appraiser_supplied")) add("APPRAISER_SUPPLIED_EVIDENCE", "Selected evidence includes appraiser-supplied records; the appraiser's attribution is not independent web verification.");
  if (candidates.some((item) => mileageGap(item, inputs))) add("MILEAGE_SELECTION_POLICY", "Automatic selection flags a mileage difference greater than the larger of 50,000 km or 30% of subject mileage (miles converted to kilometres). This conservative product policy is not a Canadian appraisal standard; inclusion requires a supported mileage adjustment or recorded appraiser rationale.");
  if (invalidPhotoReferences.length || invalidCandidatePhotos) add("PHOTO_REFERENCE_INVALID", "Evidence cited a photo that is not present in this report. Unsupported references are excluded from the reference ledger and automatic calculations.", "critical");
  if (photoFindings.some((item) => item.status === "not_analyzed")) add("PHOTOS_NOT_ANALYZED", "Some uploaded photos were not successfully analyzed; review the photo status list.", "critical");
  for (const field of ["vin", "year", "make", "model"]) {
    const observations = photoFindings.flatMap((item) => item.facts.filter((fact) => fact.field === field && fact.source === "observed" && fact.value));
    const values = new Set(observations.map((fact) => normalizedText(fact.value)));
    const supplied = inputs[field as keyof SalvageAssessmentInputs];
    if (values.size > 1 || (typeof supplied === "string" || typeof supplied === "number") && values.size > 0 && [...values].some((value) => value !== normalizedText(supplied))) add(`PHOTO_${field.toUpperCase()}_CONFLICT`, `Photo-derived ${field} conflicts with another photo or supplied information. Supplied information remains authoritative; appraiser verification is required.`, "critical");
  }
  for (const warning of options.warnings || []) {
    if (typeof warning === "string") add(stableId("RESEARCH_WARNING", warning), warning);
    else if (warning && string(warning.code) && string(warning.message)) add(warning.code, warning.message, warning.severity === "critical" ? "critical" : "warning", warning.acknowledgementRequired !== false);
  }
  for (const warning of vehicleDetails?.warnings || []) add(stableId("PHOTO_VEHICLE", warning), warning);
  add("ASSESSMENT_SCOPE", "Evidence-dated valuation support only; not a structural/mechanical inspection, roadworthiness or title certification, EV battery safety determination, or insurer settlement decision.", "warning", false);
  const generatedAt = options.generatedAt && Number.isFinite(new Date(options.generatedAt).getTime()) ? new Date(options.generatedAt).toISOString() : new Date().toISOString();
  return { schemaVersion: 2, generatedAt, inputs, researchedInputs: structuredClone(inputs), stale: false,
    photoFindings, ...(vehicleDetails ? { vehicleDetails } : {}), candidates, comparables, references, valuations, repairs,
    netRecovery: { gross, deductions, knownDeductions: round(costs.reduce<number>((sum, value) => sum + (value || 0), 0)), total: net, status: net === null ? "incomplete" : "complete", formula: "Gross as-is proceeds − seller fees − transport − storage − disposal" },
    limitations: [...new Map(limitations.map((item) => [item.code, item])).values()], research: { ...options.research } };
}

function subjectFingerprint(input: SalvageAssessmentInputs): string {
  return JSON.stringify(Object.fromEntries(["year", "make", "model", "trim", "powertrain", "vin", "odometer", "odometerUnit", "vehicleOverrides", "province", "market", "effectiveDate", "lossType", "condition", "damageDescription", "documentedBrand", "brandProvince", "brandEvidenceRef"].map((key) => [key, input[key as keyof SalvageAssessmentInputs]])));
}
export function isSalvageAssessmentV2(value: unknown): value is SalvageAssessmentV2 {
  const raw = object(value);
  return raw.schemaVersion === 2 && typeof raw.generatedAt === "string" && typeof raw.stale === "boolean" && Boolean(raw.inputs && raw.researchedInputs && raw.valuations && raw.repairs && raw.netRecovery)
    && [raw.photoFindings, raw.candidates, raw.comparables, raw.references, raw.limitations].every(Array.isArray);
}
/** Preview edits recalculate user evidence but preserve the immutable research baseline. */
export function refreshSalvageAssessment(existing: SalvageAssessmentV2, rawInputs: unknown): SalvageAssessmentV2 {
  const inputs = normalizeSalvageAssessmentInputs(rawInputs);
  const suppliedIds = new Set(existing.inputs.suppliedComparables.map((item) => item.id));
  const suppliedRefIds = new Set(existing.inputs.suppliedReferences.map((item) => item.id));
  const refreshed = buildSalvageAssessment({ inputs, photoFindings: existing.photoFindings,
    vehiclePhotoExtraction: existing.vehicleDetails?.schemaVersion === 1,
    candidates: existing.candidates.filter((item) => !suppliedIds.has(item.id)), references: existing.references.filter((item) => !suppliedRefIds.has(item.id)),
    warnings: existing.limitations.filter((item) => item.code.startsWith("RESEARCH_") || item.code.startsWith("BUDGET_") || item.code.startsWith("PROVIDER_")),
    generatedAt: existing.generatedAt, research: structuredClone(existing.research) });
  refreshed.researchedInputs = structuredClone(existing.researchedInputs);
  refreshed.stale = subjectFingerprint(refreshed.inputs) !== subjectFingerprint(existing.researchedInputs);
  if (refreshed.stale) refreshed.limitations.push({ code: "RESEARCH_STALE", message: "Material subject details changed after research. Research again before relying on the previous evidence selection.", severity: "critical", acknowledgementRequired: true });
  return refreshed;
}

/** Runtime check for persisted/untrusted versioned snapshots; legacy records are not upgraded here. */
export function validateSalvageAssessment(value: unknown): { valid: boolean; errors: string[] } {
  if (!isSalvageAssessmentV2(value)) return { valid: false, errors: ["Invalid versioned assessment structure"] };
  try {
  const errors: string[] = [];
  if (!Number.isFinite(new Date(value.generatedAt).getTime())) errors.push("Invalid generatedAt");
  if (value.candidates.length > 20 || value.comparables.filter((item) => item.basket === "pre_loss").length > 6 || value.comparables.filter((item) => item.basket === "as_is").length > 6) errors.push("Comparable limits exceeded");
  if (value.photoFindings.length > 50) errors.push("Photo limit exceeded");
  const references = new Set(value.references.map((ref) => ref.id));
  if (references.size !== value.references.length) errors.push("Duplicate reference IDs");
  for (const ref of value.references) if (ref.kind === "web" && !safeSalvageSourceUrl(ref.url)) errors.push("Unsafe evidence URL");
  for (const candidate of value.candidates) for (const id of candidate.referenceIds) if (!references.has(id)) errors.push(`Unknown evidence reference: ${id}`);
  const rebuilt = refreshSalvageAssessment(value, value.inputs);
  for (const key of ["preLoss", "asIs"] as const) if (JSON.stringify(value.valuations[key]) !== JSON.stringify(rebuilt.valuations[key])) errors.push(`Inconsistent ${key} calculation`);
  if (value.repairs.total !== rebuilt.repairs.total || value.repairs.knownSubtotal !== rebuilt.repairs.knownSubtotal) errors.push("Inconsistent repair calculation");
  if (value.netRecovery.total !== rebuilt.netRecovery.total) errors.push("Inconsistent net calculation");
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
  } catch {
    return { valid: false, errors: ["Malformed versioned assessment fields"] };
  }
}

/** Compatibility fields are a projection, never an alternative valuation source. */
export function projectSalvageAssessmentLegacyFields(assessment: SalvageAssessmentV2): Record<string, unknown> {
  const { inputs, valuations, repairs } = assessment;
  const repairItems = repairs.parts.map((item) => ({ name: item.description, quantity: item.quantity, unit_price: item.unitPrice,
    line_total: item.total, referenceIds: [...item.referenceIds], appraiserReason: item.appraiserReason }));
  const labourItems = repairs.labour.map((item) => ({ task: item.description, hours: item.hours, rate_per_hour: item.rate,
    line_total: item.total, referenceIds: [...item.referenceIds], appraiserReason: item.appraiserReason }));
  const display = (value: number | null, currency = "CAD") => value === null ? "Unavailable" : `${currency} ${value.toFixed(2)}`;
  return {
    currency: "CAD", year: inputs.year === null ? "" : String(inputs.year), make: inputs.make || "", item_model: inputs.model || "", vin: inputs.vin || "",
    item_condition: inputs.condition || "", damage_description: inputs.damageDescription || "",
    reported_loss_type: inputs.lossType || "", actual_cash_value: valuations.preLoss.amount,
    // Reserve and replacement cost are different concepts, not aliases for ACV or salvage.
    replacement_cost: null, recommended_reserve: null,
    valuation: { fairMarketValue: display(valuations.asIs.amount), summary: valuations.asIs.method, confidence_level: "Not scored",
      pre_loss_market_value: valuations.preLoss.amount, as_is_salvage_value: valuations.asIs.amount,
      net_auction_recovery: assessment.netRecovery.total, currency: "CAD", price_basis: valuations.asIs.priceBasis,
      status: valuations.asIs.status, limitations: assessment.limitations.map((item) => item.message) },
    repair_items: repairItems, labour_breakdown: labourItems, labour_rate_default: null,
    parts_subtotal: repairs.partsTotal, labour_total: repairs.labourTotal,
    repair_estimate: { parts: repairs.partsTotal, parts_subtotal: repairs.partsTotal, parts_itemized: true,
      labour: repairs.labourTotal, labour_total: repairs.labourTotal, labour_itemized: true, labour_rate_default: null,
      parts_items: repairItems, labour_breakdown: labourItems, charges: structuredClone(repairs.charges),
      charges_total: repairs.chargesTotal, known_subtotal: repairs.knownSubtotal, total: repairs.total,
      shop_supplies: null, miscellaneous: null, taxes: null, less_betterment: null, status: repairs.status },
    comparableItems: assessment.comparables.map((item) => ({
      title: item.title, link: item.url || "", price: display(item.price, item.currency || "Currency unknown"), price_numeric: item.price,
      currency: item.currency, location: item.location || "", snippet: item.condition || "", image_url: "",
      details: { basket: item.basket, price_basis: item.priceBasis, event_date: item.eventDate,
        source: item.sourceName, year: item.year, make: item.make, model: item.model, trim: item.trim,
        odometer: item.odometer, odometer_unit: item.odometerUnit, documented_brand: item.brand,
        original_price: item.price, original_currency: item.currency, adjusted_cad: item.adjustedPrice,
        reference_ids: item.referenceIds.join(", "), verification: item.verification },
    })),
    estimate_warning: "Estimates require appraiser verification. Unknown costs are unavailable, not zero; supported line totals and explicit charges are shown in the Canadian assessment.",
  };
}
