import {
  allowedCategories,
  assetCategorySpecs,
  masterSpecHeaders,
  type AssetCategorySpec,
} from "./assetCategorySpecs.js";
import { extractVinFromText } from "../service/vehicleApiService.js";
import { normalizeAssetConditionSelectionValue } from "./assetConditionSelections.js";
import { extractHourMeterReading } from "./hourMeterReading.js";

export const AUCTIONEER_NOT_FOUND = "Not Found";

export type AuctioneerSpecRow = {
  field: string;
  value: string;
  checked: boolean;
};

export const MANDATORY_AUCTIONEER_SPEC_FIELDS = [
  "Serial Number",
  "Has Key",
  "Running Condition",
  "Ownership Type",
] as const;

const PRIORITY_AUCTIONEER_SPEC_FIELDS = [...MANDATORY_AUCTIONEER_SPEC_FIELDS] as const;

const categorySpecByKey = new Map(
  assetCategorySpecs.map((spec) => [normalizeAuctioneerSpecKey(spec.childCategory), spec])
);
const categoryNameByKey = new Map(
  allowedCategories.map((category) => [normalizeAuctioneerSpecKey(category), category])
);
const shippingContainerCategory =
  categoryNameByKey.get("shippingcontainers") ||
  allowedCategories.find((category) => /shipping\s+containers?/i.test(category)) ||
  "Shipping Containers";

export function normalizeAuctioneerSpecKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function isBoilerplateAuctionText(value: unknown): boolean {
  const text = cleanText(value);
  return (
    /title clearance clarification fee/i.test(text) ||
    /applied to your invoice/i.test(text) ||
    /over and above the purchase price/i.test(text) ||
    /applicable taxes/i.test(text) ||
    /following the close of the sale/i.test(text)
  );
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMissingMarker(value: unknown): boolean {
  const text = cleanText(value);
  return /^(n\/a|na|none|null|unknown|not visible|not found|tbd)$/i.test(text);
}

function isNegativeMarker(value: unknown): boolean {
  const text = cleanText(value);
  return /^(false|n\/a|na|none|null|unknown|not visible|not found|tbd)$/i.test(text) ||
    /^no\s*[-:]/i.test(text) ||
    /^not\s+(?:available|applicable)(?:\b|\s|[-:])/i.test(text);
}

export function normalizeVisiblePresenceValue(value: unknown): string {
  const text = cleanText(value);
  if (!text) return "";
  if (/^(?:(?:not|no)\s+visible|visible(?:\s*[:=-]\s*|\s+)(?:no|false))$/i.test(text)) {
    return "No";
  }
  if (/^(?:visible|visible(?:\s*[:=-]\s*|\s+)(?:yes|true))$/i.test(text)) {
    return "Yes";
  }
  return "";
}

function cleanResolvedValue(value: unknown): string {
  const text = cleanText(value);
  if (!text || isBoilerplateAuctionText(text)) return "";
  const visiblePresenceValue = normalizeVisiblePresenceValue(text);
  if (visiblePresenceValue) return visiblePresenceValue;
  if (isMissingMarker(text)) return AUCTIONEER_NOT_FOUND;
  return text;
}

function isUsefulResolvedValue(value: unknown): boolean {
  const text = cleanResolvedValue(value);
  return !!text && text !== AUCTIONEER_NOT_FOUND;
}

const HOURS_FIELD_ALIASES = [
  "Engine Hours (Showing Unverified)",
  "Engine Hours",
  "Hours (Showing Unverified)",
  "Showing Hours",
  "Hours",
  "Hour Meter",
  "Hour Meter Reading",
  "Meter Hours",
  "Operating Hours",
] as const;

const HOURS_FIELD_ALIAS_KEYS = new Set(
  HOURS_FIELD_ALIASES.flatMap((field) => [
    normalizeAuctioneerSpecKey(field),
    normalizeAuctioneerSpecKey(field.replace(/\s*\([^)]*\)/g, "").trim()),
  ])
);

function normalizedBaseFieldKey(field: string): string {
  return normalizeAuctioneerSpecKey(field.replace(/\s*\([^)]*\)/g, "").trim());
}

function isHoursFieldAlias(field: string): boolean {
  return HOURS_FIELD_ALIAS_KEYS.has(normalizeAuctioneerSpecKey(field)) ||
    HOURS_FIELD_ALIAS_KEYS.has(normalizedBaseFieldKey(field));
}

function isMileageFieldAlias(field: string): boolean {
  const key = normalizedBaseFieldKey(field);
  return key === "mileage" || key === "showingmileage" || key === "odometer";
}

function groupNumericLiteral(value: string): string {
  const normalized = value.replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return value;
  const [integer, fraction] = normalized.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function isRecognizedMeasurementSuffix(value: string): boolean {
  return /^(?:kg|kgs?|kilograms?|lb|lbs|pounds?|g|grams?|t|tons?|tonnes?|kw|hp|psi|kpa|mpa|rpm|mm|cm|metres?|meters?|ft|feet|in|inches?|litres?|liters?|gal|gallons?)(?:\s*\([^)]*\))?$/i.test(
    value
  );
}

/**
 * Formats measurement values only when the field establishes their meaning.
 * Generic number formatting would corrupt years, VINs, model numbers,
 * dimensions, and engine displacement, so those values are left untouched.
 */
export function formatAuctioneerSpecValue(field: string, value: unknown): string {
  const text = cleanText(value);
  if (!text || text === AUCTIONEER_NOT_FOUND) return text;
  const match = text.match(/^(\d[\d,]*(?:\.\d+)?)\s*(.*)$/);
  if (!match) return text;

  const number = groupNumericLiteral(match[1]);
  const suffix = match[2].trim();
  if (isHoursFieldAlias(field)) {
    if (!suffix || /^(?:h|hr|hrs|hour|hours)(?:\s*\([^)]*\))?$/i.test(suffix)) {
      return `${number} Hours`;
    }
    return text;
  }

  if (isMileageFieldAlias(field)) {
    if (!suffix) return number;
    const unitMatch = suffix.match(
      /^(km|kilometres?|kilometers?|mi|miles?)(\s*\([^)]*\))?$/i
    );
    if (!unitMatch) return text;
    const unit = /^mi(?:le)?s?$/i.test(unitMatch[1]) ? "mi" : "km";
    return `${number} ${unit}${unitMatch[2] || ""}`;
  }

  // A recognized unit makes the value safe to group. Only rewrite when the
  // grouping actually changes the number, preserving values such as 3.5L.
  if (number !== match[1] && isRecognizedMeasurementSuffix(suffix)) {
    return `${number} ${suffix}`;
  }

  return text;
}

function isBucketFieldAlias(field: string): boolean {
  const key = normalizedBaseFieldKey(field);
  return key === "bucket" || key === "buckettype";
}

function fieldVariants(field: string, canonicalFields: string[] = []): string[] {
  const base = field.replace(/\s*\([^)]*\)/g, "").trim();
  const variants = [field, base].filter(Boolean);
  const dimension = dimensionField(field, canonicalFields);
  if (dimension) variants.push(dimension.axis, `Overall ${dimension.axis}`);
  for (const variant of [...variants]) {
    if (/\bcolor\b/i.test(variant)) variants.push(variant.replace(/\bColor\b/g, "Colour"));
    if (/\bcolour\b/i.test(variant)) variants.push(variant.replace(/\bColour\b/g, "Color"));
    if (isAuctioneerSerialField(variant)) variants.push("Serial Number", "VIN", "SN", "S/N", "Serial No", "S. No");
    if (/^has\s*key$/i.test(variant)) variants.push("Has Keys", "Keys", "Key");
    if (/^running\s*condition$/i.test(variant)) variants.push("Condition", "Working Condition");
    if (/^fuel\s*type$/i.test(variant)) variants.push("Fuel", "Primary Fuel Type");
    if (/^ownership\s*type$/i.test(variant)) variants.push("Legal", "Title Status");
    if (isMileageFieldAlias(variant)) {
      variants.push(
        "Odometer (Showing Unverified)",
        "Odometer",
        "Showing Mileage",
        "Mileage (Showing Unverified)",
        "Mileage"
      );
    }
    if (isHoursFieldAlias(variant)) variants.push(...HOURS_FIELD_ALIASES);
    if (isBucketFieldAlias(variant)) variants.push("Bucket Type", "Bucket");
    if (/^engine\s*manufacturer$/i.test(variant)) {
      variants.push("Engine Make", "Motor Manufacturer", "Motor Make");
    }
    if (/^engine\s*model$/i.test(variant)) variants.push("Motor Model");
    if (/^engine\s*(?:\/|\s)?\s*(?:hp|horsepower)$/i.test(variant)) {
      variants.push("Engine/HP", "Engine HP", "Engine Horsepower");
    }
  }
  return Array.from(new Set(variants));
}

export function auctioneerSpecFieldAliases(field: string, categoryFields: string[] = []): string[] {
  return fieldVariants(field, categoryFields);
}

export function isAuctioneerSerialField(field: string): boolean {
  const key = normalizedBaseFieldKey(field);
  return key === "serialnumber" || key === "vin" || key === "sn" || key === "serialno" || key === "sno";
}

export function stripRedundantSerialLabel(field: string, value: unknown): string {
  const text = cleanText(value);
  if (!text || !isAuctioneerSerialField(field)) return text;
  return text.replace(/^(?:vin|sn|s\/n|serial(?:\s*(?:number|no\.?|#))?)\s*[:#-]\s*/i, "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function structuredSpecsToAuctioneerRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isPlainObject(entry)) continue;
      const field = cleanText(entry.field);
      const text = cleanResolvedValue(entry.value);
      if (field && text) out[field] = text;
    }
    return out;
  }

  if (isPlainObject(value)) {
    for (const [field, raw] of Object.entries(value)) {
      const cleanField = cleanText(field);
      const text = cleanResolvedValue(raw);
      if (cleanField && text) out[cleanField] = text;
    }
  }
  return out;
}

function reviewedSpecRecord(value: unknown): Record<string, string> {
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.filter(isPlainObject).map(entry => [cleanText(entry.field), entry.value])
    : isPlainObject(value) ? Object.entries(value) : [];
  return Object.fromEntries(entries.filter(([field]) => !!cleanText(field)).map(([field, text]) => [cleanText(field), String(text ?? "").trim()]));
}

function reviewedSpecValue(record: Record<string, string>, field: string): string {
  if (Object.prototype.hasOwnProperty.call(record, field)) return record[field];
  const variants = new Set(fieldVariants(field).map(normalizeAuctioneerSpecKey));
  const key = Object.keys(record).find(candidate => variants.has(normalizeAuctioneerSpecKey(candidate)));
  return key === undefined ? "" : record[key];
}

export function mergeAuctioneerSpecRecords(...records: Array<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const record of records) {
    for (const [field, rawValue] of Object.entries(record || {})) {
      const cleanField = cleanText(field);
      const value = cleanResolvedValue(rawValue);
      if (!cleanField || !value) continue;
      const key = normalizeAuctioneerSpecKey(cleanField);
      const existingKey = Object.keys(out).find(
        (candidate) => normalizeAuctioneerSpecKey(candidate) === key
      );
      if (!existingKey) {
        out[cleanField] = value;
        continue;
      }
      const existingValue = cleanResolvedValue(out[existingKey]);
      if (existingValue === AUCTIONEER_NOT_FOUND && value !== AUCTIONEER_NOT_FOUND) {
        out[existingKey] = value;
      }
    }
  }
  return out;
}

function parseHtmlSpecsToAuctioneerRecord(value: unknown): Record<string, string> {
  const html = cleanText(value);
  if (!html) return {};
  const out: Record<string, string> = {};
  const paragraphMatches = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
  for (const paragraph of paragraphMatches) {
    const text = paragraph
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .trim();
    if (!text) continue;
    const separatorIndex = text.indexOf(":");
    if (separatorIndex <= 0) {
      out[text] = "Yes";
      continue;
    }
    const field = text.slice(0, separatorIndex).trim();
    const specValue = text.slice(separatorIndex + 1).trim();
    if (field && specValue) out[field] = specValue;
  }
  return out;
}

export function collectAuctioneerSpecRecord(lot: any): Record<string, string> {
  if (!lot || typeof lot !== "object") return {};
  // An explicitly reviewed table is a complete snapshot, including an empty
  // table. Legacy sources are ingress evidence, not a second editable authority.
  if (lot.condition_report_specs_reviewed === true) {
    return reviewedSpecRecord(lot.condition_report_specs);
  }
  return mergeAuctioneerSpecRecords(
    structuredSpecsToAuctioneerRecord(lot?.condition_report_specs),
    structuredSpecsToAuctioneerRecord(lot?.auctioneer_import_specs),
    structuredSpecsToAuctioneerRecord(lot?.auctioneer_specs),
    structuredSpecsToAuctioneerRecord(lot?.category_specs),
    structuredSpecsToAuctioneerRecord(lot?.specifications),
    structuredSpecsToAuctioneerRecord(lot?.specs),
    structuredSpecsToAuctioneerRecord(lot?.other_specs),
    parseHtmlSpecsToAuctioneerRecord(lot?.other_specifications),
    parseHtmlSpecsToAuctioneerRecord(lot?.other_specifications_html),
    parseHtmlSpecsToAuctioneerRecord(lot?.otherSpecificationsHtml)
  );
}

/**
 * Manual values are kept separately from generated specs so a later repair or
 * enrichment pass cannot replace an administrator's explicit edit. Empty
 * strings are intentional tombstones: they suppress a generated value.
 */
export function collectAuctioneerManualSpecOverrides(lot: any): Record<string, string> {
  const raw = lot?.condition_report_specs_manual_overrides;
  if (!isPlainObject(raw)) return {};

  const overrides: Record<string, string> = {};
  for (const [rawField, rawValue] of Object.entries(raw)) {
    const field = cleanText(rawField);
    if (!field || isAuctioneerDamageField(field)) continue;
    overrides[field] = String(rawValue ?? "").trim();
  }
  return overrides;
}

export function findAuctioneerManualSpecOverride(
  overrides: Record<string, string>,
  field: string
): { found: boolean; field: string; value: string } {
  const aliases = new Set(fieldVariants(field).map(normalizeAuctioneerSpecKey).filter(Boolean));
  for (const [overrideField, value] of Object.entries(overrides || {})) {
    const overrideAliases = fieldVariants(overrideField).map(normalizeAuctioneerSpecKey);
    if (overrideAliases.some((key) => aliases.has(key))) {
      return { found: true, field: overrideField, value };
    }
  }
  return { found: false, field, value: "" };
}

export function applyAuctioneerManualSpecOverrides(
  record: Record<string, string>,
  overrides: Record<string, string>
): Record<string, string> {
  const resolved = { ...(record || {}) };
  for (const [field, value] of Object.entries(overrides || {})) {
    const aliases = new Set(fieldVariants(field).map(normalizeAuctioneerSpecKey).filter(Boolean));
    for (const existingField of Object.keys(resolved)) {
      const existingAliases = fieldVariants(existingField).map(normalizeAuctioneerSpecKey);
      if (existingAliases.some((key) => aliases.has(key))) delete resolved[existingField];
    }
    resolved[field] = value;
  }
  return resolved;
}

function getSpecValue(
  record: Record<string, string>,
  field: string,
  includeMissing = false
): string {
  const direct = record[field];
  if (direct !== undefined) {
    const text = cleanResolvedValue(direct);
    if (text && text !== AUCTIONEER_NOT_FOUND) return text;
  }

  const variants = fieldVariants(field).map(normalizeAuctioneerSpecKey);
  let sawMissing = cleanResolvedValue(direct) === AUCTIONEER_NOT_FOUND;
  for (const matchingKey of Object.keys(record).filter((key) =>
    variants.includes(normalizeAuctioneerSpecKey(key))
  )) {
    const text = cleanResolvedValue(record[matchingKey]);
    if (!text) continue;
    if (text === AUCTIONEER_NOT_FOUND) {
      sawMissing = true;
      continue;
    }
    return text;
  }
  return includeMissing && sawMissing ? AUCTIONEER_NOT_FOUND : "";
}

export function resolveAuctioneerSpecValue(
  record: Record<string, string>,
  field: string,
  includeMissing = false
): string {
  return getSpecValue(record, field, includeMissing);
}

function hasMissingSpecMarker(record: Record<string, string>, field: string): boolean {
  return getSpecValue(record, field, true) === AUCTIONEER_NOT_FOUND;
}

function collectDeletedSpecKeys(lot: any): Set<string> {
  const rawValues = [
    lot?.condition_report_specs_deleted,
    lot?.deleted_condition_report_specs,
    lot?.removed_condition_report_specs,
    lot?.hidden_condition_report_specs,
  ];
  const keys = new Set<string>();
  const addField = (field: unknown) => {
    const key = normalizeAuctioneerSpecKey(field);
    if (key) keys.add(key);
    if (isAuctioneerSerialField(String(field ?? ""))) keys.add("serialnumber");
  };
  for (const raw of rawValues) {
    if (Array.isArray(raw)) {
      raw.forEach(addField);
    } else if (isPlainObject(raw)) {
      Object.entries(raw).forEach(([field, deleted]) => {
        if (deleted) addField(field);
      });
    }
  }
  return keys;
}

export function isAuctioneerSpecFieldDeleted(lot: any, field: string, categoryFields: string[] = []): boolean {
  const deleted = collectDeletedSpecKeys(lot);
  return fieldVariants(field, categoryFields).some(alias => deleted.has(normalizeAuctioneerSpecKey(alias)));
}

/** A bare dimension aliases Overall only where the category registry has one
 * unambiguous form. Internal/cargo/bed/working dimensions are never aliases. */
function dimensionField(field: string, canonicalFields: string[]): { axis: string; field: string } | undefined {
  const key = normalizedBaseFieldKey(field);
  for (const axis of ["Length", "Width", "Height"]) {
    const bare = axis.toLowerCase(), overall = `overall${bare}`;
    if (key !== bare && key !== overall) continue;
    const matches = canonicalFields.filter(candidate => [bare, overall].includes(normalizedBaseFieldKey(candidate)));
    const forms = new Set(matches.map(normalizedBaseFieldKey));
    if (forms.size === 1) return { axis, field: matches[0] };
  }
  return undefined;
}

function collectCustomSpecOrder(lot: any): string[] {
  const rawValues = [
    lot?.condition_report_specs_custom_order,
    lot?.custom_condition_report_specs_order,
    lot?.auctioneer_specs_custom_order,
  ];
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawValues) {
    if (!Array.isArray(raw)) continue;
    for (const value of raw) {
      const field = cleanText(value);
      const key = normalizeAuctioneerSpecKey(field);
      if (!field || !key || seen.has(key)) continue;
      seen.add(key);
      fields.push(field);
    }
  }
  return fields;
}

function preferredHoursField(fields: string[], categoryConfigured: boolean): string {
  const candidates = fields.filter(isHoursFieldAlias);
  if (candidates.length === 0) return "";
  if (categoryConfigured) return candidates[0];

  const priority = [
    "enginehours",
    "showinghours",
    "hours",
    "hourmeter",
    "hourmeterreading",
    "meterhours",
    "operatinghours",
  ];
  return [...candidates].sort((left, right) => {
    const leftRank = priority.indexOf(normalizedBaseFieldKey(left));
    const rightRank = priority.indexOf(normalizedBaseFieldKey(right));
    return (leftRank < 0 ? priority.length : leftRank) -
      (rightRank < 0 ? priority.length : rightRank);
  })[0];
}

function preferredBucketField(fields: string[]): string {
  return fields.find((field) => normalizedBaseFieldKey(field) === "buckettype") ||
    fields.find((field) => normalizedBaseFieldKey(field) === "bucket") ||
    "";
}

function preferredMileageField(fields: string[]): string {
  return fields.find((field) => normalizedBaseFieldKey(field) === "odometer") || "";
}

function canonicalMileageField(field: string): string {
  return normalizedBaseFieldKey(field) === "odometer"
    ? field
    : "Odometer (Showing Unverified)";
}

function canonicalizeSpecField(
  field: string,
  canonicalFields: string[],
  categoryConfigured: boolean
): string {
  const dimension = categoryConfigured ? dimensionField(field, canonicalFields) : undefined;
  if (dimension) return dimension.field;
  if (isMileageFieldAlias(field)) {
    return preferredMileageField(canonicalFields) || canonicalMileageField(field);
  }
  if (isHoursFieldAlias(field)) {
    return preferredHoursField(canonicalFields, categoryConfigured) || field;
  }
  if (isBucketFieldAlias(field)) {
    return preferredBucketField(canonicalFields) || field;
  }
  return canonicalFields.find(
    (candidate) => normalizeAuctioneerSpecKey(candidate) === normalizeAuctioneerSpecKey(field)
  ) || field;
}

function canonicalizeSpecRecord(record: Record<string, string>, fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [field, value] of Object.entries(record)) {
    const canonical = canonicalizeSpecField(field, fields, fields.length > 0);
    // An explicit registry-labelled value wins over an older alias regardless
    // of source order. Manual overrides are applied separately, afterwards.
    if (Object.prototype.hasOwnProperty.call(result, canonical) &&
        normalizeAuctioneerSpecKey(field) !== normalizeAuctioneerSpecKey(canonical)) continue;
    result[canonical] = value;
  }
  return result;
}

function manualOverridesForLot(lot: any, fields: string[]): Record<string, string> {
  const overrides = canonicalizeSpecRecord(collectAuctioneerManualSpecOverrides(lot), fields);
  if (lot?.condition_report_specs_reviewed !== true) return overrides;
  const canonical = canonicalizeSpecRecord(reviewedSpecRecord(lot.condition_report_specs), fields);
  // A legacy override for a row removed from the reviewed table cannot add it
  // back. Empty overrides remain useful suppression evidence.
  return Object.fromEntries(Object.entries(overrides).filter(([field, value]) =>
    !value || Object.keys(canonical).some(key =>
      fieldVariants(field, fields).map(normalizeAuctioneerSpecKey).includes(normalizeAuctioneerSpecKey(key)))));
}

/** Editor projections must use the same reviewed-table authority as exports. */
export function collectEffectiveAuctioneerManualSpecOverrides(lot: any): Record<string, string> {
  return manualOverridesForLot(lot, resolveAuctioneerCategorySpec(lot?.categories, lot)?.fields || []);
}

function canonicalizeSpecFieldList(
  fields: string[],
  canonicalFields: string[],
  categoryConfigured: boolean
): string[] {
  const seen = new Set<string>();
  const canonical: string[] = [];
  for (const field of fields) {
    const resolved = canonicalizeSpecField(field, canonicalFields, categoryConfigured);
    const key = normalizeAuctioneerSpecKey(resolved);
    if (!resolved || !key || seen.has(key)) continue;
    seen.add(key);
    canonical.push(resolved);
  }
  return canonical;
}

function canonicalCategory(value: unknown): string {
  const raw = cleanText(value);
  return categoryNameByKey.get(normalizeAuctioneerSpecKey(raw)) || raw;
}

function inferCategory(lot: any, conditionText = ""): string {
  const rawSearchableText = [lot?.categories, lot?.title, lot?.description, lot?.details, conditionText]
    .filter(Boolean)
    .join(" ");
  if (
    /\b(?:shipping|storage|sea|cargo|freight|c[-\s]?can|seacan)\s+containers?\b/i.test(rawSearchableText) ||
    /\b(?:20|40|45)\s*(?:ft|foot|')\s+(?:shipping|storage|sea|cargo)?\s*containers?\b/i.test(rawSearchableText)
  ) {
    return shippingContainerCategory;
  }

  const direct = canonicalCategory(
    lot?.categories || lot?.category || lot?.child_category || lot?.asset_category
  );
  if (direct) return direct;

  const searchable = normalizeAuctioneerSpecKey(
    [lot?.title, lot?.description, lot?.details, conditionText].filter(Boolean).join(" ")
  );
  const byText = [...allowedCategories]
    .sort((left, right) => right.length - left.length)
    .find((category) => {
      const key = normalizeAuctioneerSpecKey(category);
      return key.length > 5 && searchable.includes(key);
    });
  if (byText) return byText;

  const specKeys = Object.keys(collectAuctioneerSpecRecord(lot)).map(
    normalizeAuctioneerSpecKey
  );
  if (specKeys.length === 0) return "";

  let best: AssetCategorySpec | undefined;
  let bestScore = 0;
  for (const spec of assetCategorySpecs) {
    const fieldKeys = new Set(spec.fields.map(normalizeAuctioneerSpecKey));
    const score = specKeys.reduce((sum, key) => sum + (fieldKeys.has(key) ? 1 : 0), 0);
    if (score > bestScore) {
      best = spec;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best?.childCategory || "" : "";
}

export function resolveAuctioneerCategorySpec(
  category: unknown,
  lot?: any,
  conditionText = ""
): AssetCategorySpec | null {
  const resolved = canonicalCategory(category || inferCategory(lot, conditionText));
  if (!resolved) return null;
  return categorySpecByKey.get(normalizeAuctioneerSpecKey(resolved)) || null;
}

function getDecodedVinValue(lot: any, key: string): string {
  const decoded = lot?.vinDecoded || lot?.vin_decoded || lot?.vinDecode || lot?.vin_decode;
  if (!decoded || typeof decoded !== "object") return "";
  const aliases: Record<string, string[]> = {
    vin: ["vin", "VIN"],
    trim: ["trim", "Trim"],
    bodyClass: ["bodyClass", "BodyClass", "Body Class"],
    driveType: ["driveType", "DriveType", "Drive Type"],
    engineCylinders: ["engineCylinders", "EngineCylinders", "Engine Number of Cylinders"],
    displacementL: ["displacementL", "DisplacementL", "Displacement (L)"],
    fuelType: ["fuelType", "FuelType", "FuelTypePrimary", "Fuel Type - Primary"],
    transmissionStyle: ["transmissionStyle", "TransmissionStyle", "Transmission Style"],
    transmissionSpeeds: ["transmissionSpeeds", "TransmissionSpeeds", "Transmission Speeds"],
    vehicleType: ["vehicleType", "VehicleType", "Vehicle Type"],
  };
  for (const candidate of aliases[key] || [key]) {
    const value = decoded[candidate];
    if (value !== undefined && value !== null) return cleanResolvedValue(value);
  }
  return "";
}

function cleanSerialCandidate(value: unknown): string {
  const text = cleanResolvedValue(value);
  if (!text || text === AUCTIONEER_NOT_FOUND) return "";
  if (/^(?:vin|sn|s\/n|serial(?:\s*(?:number|no\.?|#))?)\s*[:#-]?\s*$/i.test(text)) {
    return "";
  }
  return text;
}

/** A reviewed value (including a deliberate blank) outranks captured aliases. */
export function resolveAuctioneerSerialOverride(lot: any): { found: boolean; value: string } {
  const deletedSpecKeys = collectDeletedSpecKeys(lot);
  if (fieldVariants("Serial Number").some((field) => deletedSpecKeys.has(normalizeAuctioneerSpecKey(field)))) {
    return { found: true, value: "" };
  }
  const manual = findAuctioneerManualSpecOverride(
    manualOverridesForLot(lot, resolveAuctioneerCategorySpec(lot?.categories, lot)?.fields || []),
    "Serial Number"
  );
  if (!manual.found && lot?.condition_report_specs_reviewed === true) {
    return { found: true, value: cleanSerialCandidate(getSpecValue(structuredSpecsToAuctioneerRecord(lot.condition_report_specs), "Serial Number")) };
  }
  return { found: manual.found, value: manual.found ? cleanSerialCandidate(manual.value) : "" };
}

export function deriveAuctioneerSerial(lot: any): string {
  const override = resolveAuctioneerSerialOverride(lot);
  if (override.found) return override.value;
  const specs = collectAuctioneerSpecRecord(lot);
  const decodedVin = getDecodedVinValue(lot, "vin");
  const decodedVinLabel = decodedVin ? `VIN: ${decodedVin}` : "";
  const directValues = [
    lot?.serial_number,
    lot?.serial_no_or_label,
    lot?.sn_vin,
    lot?.vin,
    lot?.sn,
    decodedVinLabel,
    getSpecValue(specs, "Serial Number"),
    getSpecValue(specs, "VIN"),
    getSpecValue(specs, "SN"),
  ];
  for (const value of directValues) {
    const text = cleanSerialCandidate(value);
    if (text) return text;
  }

  const serialText = [
    lot?.serial_number,
    lot?.serial_no_or_label,
    lot?.sn_vin,
    lot?.title,
    lot?.description,
    lot?.details,
  ]
    .filter(Boolean)
    .join(" ");
  const vin = extractVinFromText(serialText);
  if (vin) return `VIN: ${vin}`;
  const serial = serialText.match(
    /\b(?:serial(?:\s*(?:number|no\.?|#))?|s\/n|sn)(?:\s*[:#-]\s*|\s+)([A-Z0-9*.-]{4,32})\b/i
  )?.[1];
  return serial ? `SN: ${serial}` : "";
}

function parseSpecValueFromText(text: string, field: string, canonicalFields: string[] = []): string {
  if (!text) return "";
  // Validate the whole reading before generic clause/label parsing can split
  // malformed numeric punctuation or derive only a trailing digit group.
  if (isHoursFieldAlias(field)) return extractHourMeterReading(text);
  const parts = text
    .split(/[;\n]+|,(?=\s*[A-Z])/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const variant of fieldVariants(field, canonicalFields)) {
    // A label must be followed by a separator: VIN must not consume Vintage,
    // nor SN consume Snowmobile. Keep whitespace-only and compact VIN:123 forms.
    const startPattern = new RegExp(`^${escapeRegExp(variant)}(?:\\s*[:#-]\\s*|\\s+)(.+)$`, "i");
    const partMatch = parts
      .map((part) => part.match(startPattern)?.[1]?.trim() || "")
      .map(cleanResolvedValue)
      .find((value) => value && value !== AUCTIONEER_NOT_FOUND);
    if (partMatch) return partMatch;

    const inlinePattern = new RegExp(
      `(?:^|[,;\\n])\\s*${escapeRegExp(variant)}(?:\\s*[:#-]\\s*|\\s+)([^,;\\n]+)`,
      "i"
    );
    const inlineMatch = cleanResolvedValue(text.match(inlinePattern)?.[1] || "");
    if (inlineMatch && inlineMatch !== AUCTIONEER_NOT_FOUND) return inlineMatch;
  }

  const key = normalizeAuctioneerSpecKey(field);
  const plainText = text.replace(/\s+/g, " ").trim();

  if (key.includes("doorcount") || key === "doors") {
    return plainText.match(/\bdoor\s+count\s*[:\-]?\s*(\d+)\b/i)?.[1] ||
      plainText.match(/\b(\d+)\s*[- ]?\s*door\b/i)?.[1] ||
      "";
  }
  if (key.includes("showingmileage") || key.includes("odometer") || key.includes("mileage")) {
    const match =
      plainText.match(/\bshowing\s+mileage\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
      plainText.match(/\bmileage\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
      plainText.match(/\bodometer\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
      plainText.match(/\b([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\s*(?:showing|on\s+odometer)\b/i);
    return match ? `${match[1]} ${match[2]}` : "";
  }
  if (key.includes("showinghours") || key.includes("hours")) {
    // Standard engine-hour aliases were handled above. Specialized counters
    // require their own explicit label and must not borrow engine-hour prose.
    return "";
  }
  /*
     Bare labels below require a separator. A word boundary alone is not
     enough: "transmission slips" and "runs and drives" both pass one and would
     be stored as the value. Unlabelled prose is still read by each block's
     vocabulary pattern (automatic, 4x4, diesel...).
  */
  if (key.includes("transmissiontype") || key === "transmission") {
    const labelled =
      plainText.match(/\btransmission\s+type\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
      plainText.match(/\btransmission\b\s*[:\-]\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
      "";
    if (/\bautomatic\b/i.test(labelled || plainText)) return "Automatic";
    if (/\bmanual\b/i.test(labelled || plainText)) return "Manual";
    if (/\bcvt\b/i.test(labelled || plainText)) return "CVT";
    return labelled;
  }
  if (key.includes("drivetype") || key === "drive") {
    const labelled =
      plainText.match(/\bdrive\s+type\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
      plainText.match(/\bdrive\b\s*[:\-]\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
      "";
    const match = (labelled || plainText).match(
      /\b(4x4|4wd|awd|fwd|rwd|4-wheel drive|four wheel drive|all wheel drive|front wheel drive|rear wheel drive)\b/i
    );
    return match ? match[1].toUpperCase() : labelled;
  }
  if (key.includes("fueltype") || key === "fuel") {
    const match =
      plainText.match(/\bfuel\s+type\s*[:\-]?\s*([A-Za-z][A-Za-z /-]{2,24})\b/i) ||
      plainText.match(/\bfuel\b\s*[:\-]\s*([A-Za-z][A-Za-z /-]{2,24})\b/i) ||
      plainText.match(/\b(diesel|gasoline|gas|petrol|electric|hybrid|propane|natural gas)\b/i);
    const value = match?.[1]?.trim() || "";
    if (!value) return "";
    return /^gas$/i.test(value) ? "Gasoline" : value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  }
  if (key.includes("enginedisplacement")) {
    return plainText.match(/\b(\d+(?:\.\d+)?\s*l)\b/i)?.[1]?.toUpperCase() || "";
  }
  if (key.includes("enginemanufacturer")) {
    return (
      plainText.match(/\bengine\s+(?:manufacturer|make)\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
      plainText.match(/\bmotor\s+(?:manufacturer|make)\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
      ""
    );
  }
  if (key.includes("enginemodel")) {
    return (
      plainText.match(/\bengine\s+model\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
      plainText.match(/\bmotor\s+model\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
      ""
    );
  }
  if (key === "enginehp" || key.includes("enginehorsepower")) {
    return (
      plainText.match(/\bengine\s*(?:\/|\s)\s*hp\s*[:\-]?\s*([\d,.]+(?:\s*hp)?)\b/i)?.[1]?.trim() ||
      plainText.match(/\bengine\s+horsepower\s*[:\-]?\s*([\d,.]+(?:\s*hp)?)\b/i)?.[1]?.trim() ||
      ""
    );
  }
  if (key === "engine") {
    return (
      plainText.match(/\bengine\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
      plainText.match(/\b(\d+(?:\.\d+)?\s*l(?:\s+turbo)?[^,;\n]*)\b/i)?.[1]?.trim() ||
      ""
    );
  }
  if (key.includes("turbocharged") && /\bturbo(?:charged)?\b/i.test(plainText)) return "Yes";
  if (key === "colour" || key === "color" || key.includes("exteriorcolour") || key.includes("exteriorcolor")) {
    const match =
      plainText.match(/\bcolou?r\s*[:\-]?\s*([A-Za-z][A-Za-z /-]{2,24})\b/i) ||
      plainText.match(/\b(black|white|silver|grey|gray|red|blue|green|yellow|orange|brown|beige|tan|gold|purple|maroon)\b/i);
    const color = match?.[1]?.trim() || "";
    return color ? color.charAt(0).toUpperCase() + color.slice(1).toLowerCase() : "";
  }
  return "";
}

function selectionValue(lot: any, key: "condition" | "completeness" | "legal"): string {
  const value = cleanResolvedValue(
    normalizeAssetConditionSelectionValue(key, lot?.condition_report_selections?.[key])
  );
  return value === AUCTIONEER_NOT_FOUND ? "" : value;
}

function isSelectionNa(value: unknown): boolean {
  return /^(?:n\/a|na|not applicable)$/i.test(cleanText(value));
}

const LEGAL_SELECTION_SPEC_MATCHERS = [
  /ownershiptype/,
  /titlestatus/,
  /registrationhistory/,
];

export function isAuctioneerDamageField(field: string): boolean {
  const key = normalizeAuctioneerSpecKey(field);
  return key === "damage" || key === "damages" || key === "damageanalysis";
}

function findField(fields: string[], matchers: RegExp[]): string {
  return (
    fields.find((field) => {
      const key = normalizeAuctioneerSpecKey(field);
      return matchers.some((matcher) => matcher.test(key));
    }) || ""
  );
}

function setDerivedSpec(
  specs: Record<string, string>,
  fields: string[],
  matchers: RegExp[],
  value: unknown
) {
  const cleanValue = cleanResolvedValue(value);
  if (!cleanValue || cleanValue === AUCTIONEER_NOT_FOUND) return;
  const field = findField(fields, matchers);
  if (!field || getSpecValue(specs, field)) return;
  specs[field] = cleanValue;
}

function setSelectionControlledSpec(
  specs: Record<string, string>,
  fields: string[],
  matchers: RegExp[],
  value: unknown
) {
  const field = findField(fields, matchers);
  if (!field) return;
  const fieldKey = normalizeAuctioneerSpecKey(field);
  const existingKey = Object.keys(specs).find(
    (candidate) => normalizeAuctioneerSpecKey(candidate) === fieldKey
  );

  if (isSelectionNa(value)) {
    if (existingKey) delete specs[existingKey];
    return;
  }

  const cleanValue = cleanResolvedValue(value);
  if (!cleanValue || cleanValue === AUCTIONEER_NOT_FOUND) return;
  specs[existingKey || field] = cleanValue;
}

function legalSelectionSpecFieldKeys(fields: string[]): Set<string> {
  const mappedField = findField(fields, LEGAL_SELECTION_SPEC_MATCHERS);
  return new Set(
    [
      ...fieldVariants(mappedField),
      // Ownership Type is a mandatory auction field, even for the small set of
      // categories whose Legal choice maps to Registration History instead.
      ...fieldVariants("Ownership Type"),
    ]
      .map(normalizeAuctioneerSpecKey)
      .filter(Boolean)
  );
}

function setLegalSelectionControlledSpec(
  specs: Record<string, string>,
  fields: string[],
  value: unknown
) {
  const field = findField(fields, LEGAL_SELECTION_SPEC_MATCHERS);
  if (!field) return;
  const controlledKeys = legalSelectionSpecFieldKeys(fields);
  const existingKeys = Object.keys(specs).filter((candidate) =>
    controlledKeys.has(normalizeAuctioneerSpecKey(candidate))
  );

  if (isSelectionNa(value)) {
    existingKeys.forEach((key) => delete specs[key]);
    return;
  }

  const cleanValue = cleanResolvedValue(value);
  if (!cleanValue || cleanValue === AUCTIONEER_NOT_FOUND) return;
  existingKeys.forEach((key) => delete specs[key]);
  specs[field] = cleanValue;
}

function findExistingSpecKey(specs: Record<string, string>, field: string): string {
  const key = normalizeAuctioneerSpecKey(field);
  return Object.keys(specs).find((candidate) => normalizeAuctioneerSpecKey(candidate) === key) || "";
}

function moveNumericSeatsToCapacity(specs: Record<string, string>, fields: string[]) {
  const seatsField = findField(fields, [/^seats$/]);
  const capacityField = findField(fields, [/seatingcapacity/, /^seatcount$/, /^passengercapacity$/]);
  if (!seatsField || !capacityField) return;

  const seatsKey = findExistingSpecKey(specs, seatsField);
  const capacityKey = findExistingSpecKey(specs, capacityField);
  const seatsValue = seatsKey ? cleanResolvedValue(specs[seatsKey]) : "";
  const capacityValue = capacityKey ? cleanResolvedValue(specs[capacityKey]) : "";

  if (!seatsValue || seatsValue === AUCTIONEER_NOT_FOUND) return;
  if (/^\d+(?:\s*(?:passengers?|seats?))?$/i.test(seatsValue)) {
    if (!capacityValue) {
      specs[capacityField] = seatsValue;
    }
    delete specs[seatsKey];
  }
}

function findEngineRoleField(
  fields: string[],
  role: "manufacturer" | "model"
): string {
  const expected = role === "manufacturer" ? "enginemanufacturer" : "enginemodel";
  return fields.find((field) => normalizedBaseFieldKey(field) === expected) || "";
}

function suppressDuplicateEngineModel(specs: Record<string, string>, fields: string[]) {
  const manufacturerField = findEngineRoleField(fields, "manufacturer");
  const modelField = findEngineRoleField(fields, "model");
  if (!manufacturerField || !modelField) return;

  const manufacturer = getSpecValue(specs, manufacturerField);
  const model = getSpecValue(specs, modelField);
  if (!manufacturer || !model) return;
  if (normalizeAuctioneerSpecKey(manufacturer) !== normalizeAuctioneerSpecKey(model)) return;

  const modelKeys = new Set(fieldVariants(modelField).map(normalizeAuctioneerSpecKey));
  for (const key of Object.keys(specs)) {
    if (modelKeys.has(normalizeAuctioneerSpecKey(key))) delete specs[key];
  }
}

function hasDuplicateEngineManufacturerAndModel(
  specs: Record<string, string>,
  fields: string[],
  conditionText: string
): boolean {
  const manufacturerField = findEngineRoleField(fields, "manufacturer");
  const modelField = findEngineRoleField(fields, "model");
  if (!manufacturerField || !modelField) return false;

  const manufacturer = getSpecValue(specs, manufacturerField) ||
    parseSpecValueFromText(conditionText, manufacturerField);
  const model = getSpecValue(specs, modelField) ||
    parseSpecValueFromText(conditionText, modelField);
  return !!manufacturer && !!model &&
    normalizeAuctioneerSpecKey(manufacturer) === normalizeAuctioneerSpecKey(model);
}

function buildAugmentedSpecs(lot: any, conditionText: string, category?: string): Record<string, string> {
  const spec = resolveAuctioneerCategorySpec(category || lot?.categories, lot, conditionText);
  const canonicalFields = spec?.fields || [];
  const specs = canonicalizeSpecRecord(collectAuctioneerSpecRecord(lot), canonicalFields);
  const manualOverrides = manualOverridesForLot(lot, canonicalFields);
  const fields = spec?.fields?.length ? spec.fields : masterSpecHeaders;
  if (lot?.condition_report_specs_reviewed === true) {
    // Selection controls can update an existing mapped row, but cannot refill
    // an explicitly emptied table. Manual values/deletions still win below.
    const retainedFields = fields.filter(field => Object.keys(specs).some(key =>
      fieldVariants(field, canonicalFields).map(normalizeAuctioneerSpecKey).includes(normalizeAuctioneerSpecKey(key))));
    setSelectionControlledSpec(specs, retainedFields, [/^runningcondition$/, /^workingcondition$/],
      normalizeAssetConditionSelectionValue("condition", lot?.condition_report_selections?.condition));
    setLegalSelectionControlledSpec(specs, retainedFields,
      normalizeAssetConditionSelectionValue("legal", lot?.condition_report_selections?.legal));
    return applyAuctioneerManualSpecOverrides(specs, manualOverrides);
  }
  const visibleText = [
    lot?.title,
    lot?.description,
    lot?.details,
    lot?.serial_number,
    lot?.serial_no_or_label,
    lot?.sn_vin,
    conditionText,
  ]
    .filter(Boolean)
    .join(", ");

  const rawConditionSelection = normalizeAssetConditionSelectionValue(
    "condition",
    lot?.condition_report_selections?.condition
  );
  const rawLegalSelection = normalizeAssetConditionSelectionValue(
    "legal",
    lot?.condition_report_selections?.legal
  );
  const completeness = selectionValue(lot, "completeness");

  setDerivedSpec(specs, fields, [/^serialnumber$/, /^vin$/, /^sn$/], deriveAuctioneerSerial(lot));
  setDerivedSpec(
    specs,
    fields,
    [/^year$/, /^modelyear$/, /^yearofmanufacture$/, /^manufactureyear$/],
    lot?.year ||
      lot?.model_year ||
      lot?.modelYear ||
      getDecodedVinValue(lot, "year")
  );
  setSelectionControlledSpec(specs, fields, [/^runningcondition$/, /^workingcondition$/], rawConditionSelection);
  setDerivedSpec(specs, fields, [/haskey/, /keyspresent/, /^keys$/], /has keys?/i.test(completeness) ? "Yes" : "");
  setDerivedSpec(specs, fields, [/missingparts/], /missing parts/i.test(completeness) ? "Yes" : "");
  setDerivedSpec(specs, fields, [/incompleteunit/], /incomplete unit/i.test(completeness) ? "Yes" : "");
  setLegalSelectionControlledSpec(specs, fields, rawLegalSelection);
  setDerivedSpec(specs, fields, [/trimlevel/, /^trim$/], getDecodedVinValue(lot, "trim"));
  setDerivedSpec(specs, fields, [/bodyclass/, /^body$/], getDecodedVinValue(lot, "bodyClass"));
  setDerivedSpec(specs, fields, [/drivetype/, /^drive$/], getDecodedVinValue(lot, "driveType") || parseSpecValueFromText(visibleText, "Drive Type"));
  setDerivedSpec(specs, fields, [/enginecylinders/], getDecodedVinValue(lot, "engineCylinders"));
  setDerivedSpec(specs, fields, [/enginedisplacement/, /^displacement$/], getDecodedVinValue(lot, "displacementL") ? `${getDecodedVinValue(lot, "displacementL")}L` : parseSpecValueFromText(visibleText, "Engine Displacement"));
  setDerivedSpec(specs, fields, [/^enginemanufacturer$/], parseSpecValueFromText(visibleText, "Engine Manufacturer"));
  setDerivedSpec(specs, fields, [/^enginemodel/], parseSpecValueFromText(visibleText, "Engine Model"));
  setDerivedSpec(specs, fields, [/^enginehp$/, /^enginehorsepower$/], parseSpecValueFromText(visibleText, "Engine/HP"));
  setDerivedSpec(specs, fields, [/^engine$/], parseSpecValueFromText(visibleText, "Engine"));
  setDerivedSpec(specs, fields, [/fueltype/, /^fuel$/], getDecodedVinValue(lot, "fuelType") || parseSpecValueFromText(visibleText, "Fuel Type"));
  setDerivedSpec(specs, fields, [/turbocharged/], /\bturbo(?:charged)?\b/i.test(visibleText) ? "Yes" : "");
  setDerivedSpec(specs, fields, [/transmissiontype/, /^transmission$/], getDecodedVinValue(lot, "transmissionStyle") || parseSpecValueFromText(visibleText, "Transmission Type"));
  setDerivedSpec(specs, fields, [/transmissionspeeds/], getDecodedVinValue(lot, "transmissionSpeeds"));
  setDerivedSpec(specs, fields, [/showingmileage/, /mileage/, /odometer/], parseSpecValueFromText(visibleText, "Showing Mileage"));
  setDerivedSpec(specs, fields, [/showinghours/, /hours/], parseSpecValueFromText(visibleText, "Hours (Showing Unverified)"));
  setDerivedSpec(specs, fields, [/^colour$/, /^color$/, /exteriorcolour/, /exteriorcolor/], parseSpecValueFromText(visibleText, "Colour"));
  setDerivedSpec(specs, fields, [/doorcount/, /^doors$/], parseSpecValueFromText(visibleText, "Door Count"));
  setDerivedSpec(specs, fields, [/vehicletype/], getDecodedVinValue(lot, "vehicleType"));
  moveNumericSeatsToCapacity(specs, fields);
  suppressDuplicateEngineModel(specs, fields);

  return applyAuctioneerManualSpecOverrides(
    specs,
    manualOverrides
  );
}

function orderedAuctioneerFields(
  baseFields: string[],
  customFields: string[],
  specs: Record<string, string>
): string[] {
  if (customFields.length > 0) {
    return [
      ...customFields,
      ...PRIORITY_AUCTIONEER_SPEC_FIELDS,
      ...baseFields,
      ...Object.keys(specs),
    ];
  }
  return [
    ...PRIORITY_AUCTIONEER_SPEC_FIELDS,
    ...baseFields,
    ...Object.keys(specs),
  ];
}

export function buildAuctioneerSpecRows(
  lot: any,
  options: { conditionText?: string; category?: string; includeMissing?: boolean } = {}
): AuctioneerSpecRow[] {
  const conditionText = cleanText(options.conditionText || [lot?.description, lot?.details].filter(Boolean).join(", "));
  const spec = resolveAuctioneerCategorySpec(options.category || lot?.categories, lot, conditionText);
  const specs = buildAugmentedSpecs(lot, conditionText, options.category);
  const manualOverrides = manualOverridesForLot(lot, spec?.fields || []);
  const deletedSpecKeys = collectDeletedSpecKeys(lot);
  for (const field of spec?.fields || []) {
    if (fieldVariants(field, spec?.fields).some(alias => deletedSpecKeys.has(normalizeAuctioneerSpecKey(alias)))) {
      deletedSpecKeys.add(normalizeAuctioneerSpecKey(field));
    }
  }
  const categoryConfigured = !!spec?.fields?.length;
  const legalSelection = normalizeAssetConditionSelectionValue(
    "legal",
    lot?.condition_report_selections?.legal
  );
  const legalSelectionFieldKeys = legalSelectionSpecFieldKeys(
    spec?.fields?.length ? spec.fields : masterSpecHeaders
  );
  const rawBaseFields = categoryConfigured
    ? spec.fields
    : Object.keys(specs).length
      ? Object.keys(specs)
      : [];
  const canonicalFields = canonicalizeSpecFieldList(
    rawBaseFields,
    rawBaseFields,
    categoryConfigured
  );
  const customFields = canonicalizeSpecFieldList(
    collectCustomSpecOrder(lot),
    canonicalFields,
    categoryConfigured
  );
  const fields = canonicalizeSpecFieldList(
    orderedAuctioneerFields(canonicalFields, customFields, specs),
    canonicalFields,
    categoryConfigured
  );
  const suppressEngineModel = hasDuplicateEngineManufacturerAndModel(
    specs,
    canonicalFields,
    conditionText
  );
  const rows: AuctioneerSpecRow[] = [];
  const seen = new Set<string>();

  for (const rawField of fields) {
    const field = cleanText(rawField);
    const key = normalizeAuctioneerSpecKey(field);
    const aliasKeys = fieldVariants(field, spec?.fields).map(normalizeAuctioneerSpecKey).filter(Boolean);
    if (!field || seen.has(key) || aliasKeys.some((aliasKey) => seen.has(aliasKey)) || isAuctioneerDamageField(field)) continue;
    if (suppressEngineModel && normalizedBaseFieldKey(field) === "enginemodel") continue;
    if (key === "runningcondition" && isSelectionNa(lot?.condition_report_selections?.condition)) continue;
    if (
      isSelectionNa(legalSelection) &&
      (legalSelectionFieldKeys.has(key) ||
        aliasKeys.some((aliasKey) => legalSelectionFieldKeys.has(aliasKey)))
    ) continue;
    if (deletedSpecKeys.has(key) || aliasKeys.some((aliasKey) => deletedSpecKeys.has(aliasKey))) continue;
    aliasKeys.forEach((aliasKey) => seen.add(aliasKey));
    seen.add(key);

    const manualOverride = findAuctioneerManualSpecOverride(manualOverrides, field);
    let value = manualOverride.found
      ? manualOverride.value
      : lot?.condition_report_specs_reviewed === true ? reviewedSpecValue(specs, field)
        : getSpecValue(specs, field) || parseSpecValueFromText(conditionText, field, spec?.fields);
    if (
      !manualOverride.found &&
      lot?.condition_report_specs_reviewed !== true &&
      !value &&
      (hasMissingSpecMarker(specs, field) || options.includeMissing === true)
    ) {
      value = AUCTIONEER_NOT_FOUND;
    }
    const checked = isStandaloneSpecValue(field, value);
    const normalizedValue = checked
      ? "Yes"
      : formatAuctioneerSpecValue(field, stripRedundantSerialLabel(field, value));
    rows.push({
      field,
      value: normalizedValue,
      checked,
    });
  }

  return rows;
}

export function isStandaloneSpecValue(field: string, value: string): boolean {
  const normalizedField = normalizeAuctioneerSpecKey(field);
  const normalizedValue = normalizeAuctioneerSpecKey(value);
  return (
    normalizedValue === "yes" ||
    normalizedValue === "true" ||
    normalizedValue === "y" ||
    normalizedValue === "present" ||
    normalizedValue === "included" ||
    normalizedValue === normalizedField
  );
}

export function isMandatoryAuctioneerSpecField(field: string): boolean {
  const key = normalizeAuctioneerSpecKey(field);
  return MANDATORY_AUCTIONEER_SPEC_FIELDS.some(
    (mandatoryField) => normalizeAuctioneerSpecKey(mandatoryField) === key
  );
}

export function shouldDisplayAuctioneerSpecRow(row: AuctioneerSpecRow): boolean {
  const value = cleanText(row.value);
  if (isMandatoryAuctioneerSpecField(row.field)) return true;
  if (!value) return false;
  if (isNegativeMarker(value)) return false;
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildAuctioneerOtherSpecificationsHtml(
  lot: any,
  options: { conditionText?: string; category?: string; includeMissing?: boolean } = {}
): string {
  const includeMissing = options.includeMissing === true;
  return buildAuctioneerSpecRows(lot, { ...options, includeMissing: options.includeMissing === true })
    .filter((row) => {
      if (includeMissing) return shouldDisplayAuctioneerSpecRow(row);
      return !!cleanText(row.value) && shouldDisplayAuctioneerSpecRow(row);
    })
    .map((row) =>
      `<p>${escapeHtml(row.field)}: ${escapeHtml(row.value || AUCTIONEER_NOT_FOUND)}</p>`
    )
    .join("");
}

export function normalizeAuctioneerLotSpecs(
  lot: any,
  options: { includeMissing?: boolean } = {}
): any {
  if (!lot || typeof lot !== "object") return lot;
  const serialOverride = resolveAuctioneerSerialOverride(lot);
  const conditionText = [lot?.description, lot?.details].filter(Boolean).join(", ");
  const categorySpec = resolveAuctioneerCategorySpec(lot?.categories, lot, conditionText);
  const categoryConfigured = !!categorySpec?.fields?.length;
  const rawCanonicalFields = categoryConfigured
    ? categorySpec.fields
    : Object.keys(collectAuctioneerSpecRecord(lot));
  const canonicalFields = canonicalizeSpecFieldList(
    rawCanonicalFields,
    rawCanonicalFields,
    categoryConfigured
  );
  const rows = buildAuctioneerSpecRows(lot, {
    conditionText,
    category: lot?.categories,
    includeMissing: options.includeMissing === true,
  });
  // Actual saved field names are not a category registry. Custom categories
  // must never acquire dimension aliases during repeated normalization.
  const registryFields = categorySpec?.fields || [];
  const reviewedFields = Object.keys(canonicalizeSpecRecord(reviewedSpecRecord(lot.condition_report_specs), registryFields));
  const rowsToStore = lot?.condition_report_specs_reviewed === true
    ? rows.filter(row => reviewedFields.some(field => fieldVariants(row.field, registryFields).map(normalizeAuctioneerSpecKey).includes(normalizeAuctioneerSpecKey(field))))
    : options.includeMissing === true
    ? rows
    : rows.filter((row) => {
        const value = cleanText(row.checked ? "Yes" : row.value);
        return !!value && value !== AUCTIONEER_NOT_FOUND && !isNegativeMarker(value);
      });
  const normalizedLot = {
    ...lot,
    // The editable specification table and standalone serial column are two
    // projections of the same reviewed value, not independent sources of truth.
    ...(serialOverride.found ? { serial_number: serialOverride.value } : {}),
    ...(serialOverride.found
      ? Object.fromEntries(
          ["serial_no_or_label", "sn_vin", "vin", "sn"]
            .filter((field) => Object.prototype.hasOwnProperty.call(lot, field))
            .map((field) => [field, serialOverride.value])
        )
      : {}),
    ...(Array.isArray(lot?.condition_report_specs_deleted)
      ? {
          condition_report_specs_deleted: canonicalizeSpecFieldList(
            lot.condition_report_specs_deleted.map(cleanText),
            canonicalFields,
            categoryConfigured
          ),
        }
      : {}),
    ...(Array.isArray(lot?.condition_report_specs_custom_order)
      ? {
          condition_report_specs_custom_order: canonicalizeSpecFieldList(
            lot.condition_report_specs_custom_order.map(cleanText),
            canonicalFields,
            categoryConfigured
          ),
        }
      : {}),
  };
  if (rowsToStore.length === 0) {
    return lot?.condition_report_specs_reviewed === true || isSelectionNa(
      normalizeAssetConditionSelectionValue(
        "legal",
        lot?.condition_report_selections?.legal
      )
    )
      ? { ...normalizedLot, condition_report_specs: {} }
      : normalizedLot;
  }
  return {
    ...normalizedLot,
    condition_report_specs: Object.fromEntries(
      rowsToStore.map((row) => [row.field, row.checked ? "Yes" : lot?.condition_report_specs_reviewed === true ? row.value : row.value || AUCTIONEER_NOT_FOUND])
    ),
  };
}

/** Call only at an explicit saved-preview edit/submit boundary, never AI ingress.
 * Old clients without a specification table retain the legacy ingress behavior. */
export function markPreviewDataSpecsReviewed<T extends Record<string, any>>(
  previewData: T, options: { reconcileManualOverrides?: boolean } = {}
): T {
  const mark = (lot: any): any => {
    if (!lot || typeof lot !== "object") return lot;
    const hasTable = Object.prototype.hasOwnProperty.call(lot, "condition_report_specs") &&
      (isPlainObject(lot.condition_report_specs) || Array.isArray(lot.condition_report_specs));
    let overrides: Record<string, string> | undefined;
    if (hasTable && options.reconcileManualOverrides !== false && isPlainObject(lot.condition_report_specs_manual_overrides)) {
      const fields = resolveAuctioneerCategorySpec(lot.categories, lot)?.fields || [];
      const current = canonicalizeSpecRecord(reviewedSpecRecord(lot.condition_report_specs), fields);
      overrides = {};
      for (const [field, value] of Object.entries(collectAuctioneerManualSpecOverrides(lot))) {
        const aliases = new Set(fieldVariants(field, fields).map(normalizeAuctioneerSpecKey));
        const match = Object.keys(current).find(candidate => fieldVariants(candidate, fields).some(alias => aliases.has(normalizeAuctioneerSpecKey(alias))));
        if (match) overrides[match] = current[match];
        else if (!value) overrides[field] = "";
      }
    }
    return { ...lot, ...(hasTable ? { condition_report_specs_reviewed: true } : {}),
      ...(overrides ? { condition_report_specs_manual_overrides: overrides } : {}),
      ...(Array.isArray(lot.items) ? { items: lot.items.map(mark) } : {}) };
  };
  if (!previewData || typeof previewData !== "object") return previewData;
  return { ...previewData, ...(Array.isArray(previewData.lots) ? { lots: previewData.lots.map(mark) } : {}) };
}

/** A reviewed catalogue item owns its full specification table. Parent-level
 * manual controls/selections must not refill or rewrite that independent row. */
export function reviewedAuctioneerItemSpecState(item: any): Record<string, any> {
  // A parent review is not evidence that an omitted legacy child table was
  // reviewed. Preserve its legacy projection without inheriting that marker.
  if (item?.condition_report_specs_reviewed !== true) return { condition_report_specs_reviewed: false };
  return {
    condition_report_specs: item.condition_report_specs || {},
    condition_report_specs_manual_overrides: item.condition_report_specs_manual_overrides || {},
    condition_report_selections: item.condition_report_selections || {},
    ...Object.fromEntries([
      "condition_report_specs_deleted", "deleted_condition_report_specs", "removed_condition_report_specs", "hidden_condition_report_specs",
      "condition_report_specs_custom_order", "custom_condition_report_specs_order", "auctioneer_specs_custom_order",
    ].map(key => [key, item[key] || []])),
  };
}

export function normalizePreviewDataAuctioneerSpecs<T extends Record<string, any>>(
  previewData: T,
  options: { includeMissing?: boolean } = {}
): T {
  if (!previewData || typeof previewData !== "object") return previewData;
  if (!Array.isArray(previewData.lots)) return previewData;
  return {
    ...previewData,
    lots: previewData.lots.map((lot: any) => {
      const normalizedLot = normalizeAuctioneerLotSpecs(lot, options);
      if (!Array.isArray(lot?.items)) return normalizedLot;
      return {
        ...normalizedLot,
        items: lot.items.map((item: any) =>
          normalizeAuctioneerLotSpecs(
            {
              ...item,
              lot_number: item?.lot_number ?? lot?.lot_number,
              categories: item?.categories ?? lot?.categories,
            },
            options
          )
        ),
      };
    }),
  };
}
