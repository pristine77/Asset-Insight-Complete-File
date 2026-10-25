/**
 * Enriches lot specifications as a precedence pipeline: preserve useful submitted
 * values, infer visible facts, decode VIN data, and use web-backed AI only for fields
 * still unresolved. Bounded concurrency and per-process caching protect paid providers;
 * per-lot diagnostics make partial success observable without discarding good work.
 */
import openai from "../utils/openaiClient.js";
import {
  assetCategorySpecs,
  type AssetCategorySpec,
} from "../utils/assetCategorySpecs.js";
import {
  isAuctioneerSpecFieldDeleted,
  normalizeAuctioneerLotSpecs,
} from "../utils/auctioneerSpecRows.js";
import { normalizeAssetConditionSelectionValue } from "../utils/assetConditionSelections.js";
import { extractHourMeterReading } from "../utils/hourMeterReading.js";
import {
  applyVinModelYearFallback,
  enrichLotsWithVin,
  extractVinFromText,
} from "./vehicleApiService.js";
import { getPositiveIntEnv, mapWithConcurrency } from "../utils/concurrency.js";
import { isAuctioneerSpecWebSearchEnabled } from "./systemSettingsService.js";

type SpecRecord = Record<string, string>;

export type LotListingSpecEnrichmentAnalysis = {
  lot_index: number;
  lot_number: string;
  category: string;
  status: "skipped" | "completed" | "partial" | "failed";
  cache_key?: string;
  cache_hit?: boolean;
  fields_per_chunk?: number;
  chunks_run: Array<{
    index: number;
    fields: string[];
    status: "completed" | "partial" | "failed";
    filled_fields: string[];
    unresolved_fields: string[];
    sources: Array<{ title?: string; url: string; field?: string }>;
    error?: string;
  }>;
  visible_filled: string[];
  vin_filled: string[];
  web_filled: string[];
  unresolved_fields: string[];
  sources: Array<{ title?: string; url: string; field?: string }>;
  error?: string;
};

type EnrichmentCacheEntry = {
  specs: SpecRecord;
  sources: Array<{ title?: string; url: string; field?: string }>;
  unresolvedFields: string[];
};

const enrichmentCache = new Map<string, EnrichmentCacheEntry>();

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUsefulValue(value: unknown): boolean {
  const text = cleanString(value);
  return (
    !!text &&
    !/^(n\/a|na|none|null|unknown|not visible|not found|tbd)$/i.test(text) &&
    !isBoilerplateAuctionText(text)
  );
}

function isBoilerplateAuctionText(value: unknown): boolean {
  const text = cleanString(value);
  return (
    /title clearance clarification fee/i.test(text) ||
    /applied to your invoice/i.test(text) ||
    /over and above the purchase price/i.test(text) ||
    /applicable taxes/i.test(text) ||
    /following the close of the sale/i.test(text)
  );
}

function structuredSpecsToRecord(value: unknown): SpecRecord {
  const out: SpecRecord = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isPlainObject(item)) continue;
      const field = cleanString(item.field ?? item.name ?? item.label ?? item.key);
      const rawValue = cleanString(item.value ?? item.text ?? item.result);
      if (field && rawValue) out[field] = rawValue;
    }
    return out;
  }
  if (isPlainObject(value)) {
    for (const [field, rawValue] of Object.entries(value)) {
      const cleanField = cleanString(field);
      const cleanValue = cleanString(rawValue);
      if (cleanField && cleanValue) out[cleanField] = cleanValue;
    }
  }
  return out;
}

function resolveCategorySpec(category: unknown): AssetCategorySpec | null {
  const key = normalizeKey(category);
  if (!key) return null;
  return assetCategorySpecs.find((spec) => normalizeKey(spec.childCategory) === key) || null;
}

function getExistingSpecValue(specs: SpecRecord, field: string): string {
  const direct = specs[field];
  if (isUsefulValue(direct)) return cleanString(direct);
  const fieldKey = normalizeKey(field);
  const match = Object.keys(specs).find((key) => normalizeKey(key) === fieldKey);
  return match && isUsefulValue(specs[match]) ? cleanString(specs[match]) : "";
}

function findField(fields: string[], matchers: RegExp[]): string {
  return (
    fields.find((field) => {
      const key = normalizeKey(field);
      return matchers.some((matcher) => matcher.test(key));
    }) || ""
  );
}

function setSpecIfBlank(
  specs: SpecRecord,
  fields: string[],
  matchers: RegExp[],
  value: unknown,
  filled: string[]
) {
  const cleanValue = cleanString(value);
  if (!isUsefulValue(cleanValue)) return;
  const field = findField(fields, matchers);
  if (!field || getExistingSpecValue(specs, field)) return;
  specs[field] = cleanValue;
  filled.push(field);
}

function isSelectionNa(value: unknown): boolean {
  return /^(?:n\/a|na|not applicable)$/i.test(cleanString(value));
}

const LEGAL_SELECTION_SPEC_MATCHERS = [
  /ownershiptype/,
  /titlestatus/,
  /registrationhistory/,
];

function setSpecFromSelection(
  specs: SpecRecord,
  fields: string[],
  matchers: RegExp[],
  value: unknown,
  filled: string[]
) {
  const field = findField(fields, matchers);
  if (!field) return;
  const fieldKey = normalizeKey(field);
  const existingKey = Object.keys(specs).find((key) => normalizeKey(key) === fieldKey);
  if (isSelectionNa(value)) {
    if (existingKey) delete specs[existingKey];
    return;
  }
  const cleanValue = cleanString(value);
  if (!isUsefulValue(cleanValue)) return;
  specs[existingKey || field] = cleanValue;
  filled.push(field);
}

function legalSelectionSpecFieldKeys(fields: string[]): Set<string> {
  const mappedField = findField(fields, LEGAL_SELECTION_SPEC_MATCHERS);
  const keys = new Set([
    normalizeKey(mappedField),
    normalizeKey("Ownership Type"),
    normalizeKey("Legal"),
    normalizeKey("Title Status"),
  ]);
  keys.delete("");
  return keys;
}

function setLegalSpecFromSelection(
  specs: SpecRecord,
  fields: string[],
  value: unknown,
  filled: string[]
) {
  const field = findField(fields, LEGAL_SELECTION_SPEC_MATCHERS);
  if (!field) return;
  const controlledKeys = legalSelectionSpecFieldKeys(fields);
  const existingKeys = Object.keys(specs).filter((key) =>
    controlledKeys.has(normalizeKey(key))
  );

  if (isSelectionNa(value)) {
    existingKeys.forEach((key) => delete specs[key]);
    return;
  }

  const cleanValue = cleanString(value);
  if (!isUsefulValue(cleanValue)) return;
  existingKeys.forEach((key) => delete specs[key]);
  specs[field] = cleanValue;
  filled.push(field);
}

function directVinOrSerialFromText(text: string): string {
  const labelledVin = text.match(/\bvin(?:\s*[:#-]\s*|\s+)([A-HJ-NPR-Z0-9*]{8,18})\b/i)?.[1];
  if (labelledVin) return `VIN: ${labelledVin.toUpperCase()}`;
  const vin = extractVinFromText(text);
  if (vin) return `VIN: ${vin}`;
  const labelledSerial = text.match(
    /\b(?:serial(?:\s*(?:number|no\.?|#))?|s\/n|sn)(?:\s*[:#-]\s*|\s+)([A-Z0-9*.-]{4,32})\b/i
  )?.[1];
  return labelledSerial ? `SN: ${labelledSerial}` : "";
}

function getLotVinOrSerial(lot: any): string {
  const decodedVin = cleanString(lot?.vinDecoded?.vin || lot?.vin_decoded?.vin);
  const direct = [
    lot?.serial_number,
    lot?.sn_vin,
    lot?.serial_no_or_label,
    lot?.vin,
    lot?.sn,
    decodedVin ? `VIN: ${decodedVin}` : "",
  ].map(cleanString).find(isUsefulValue);
  if (direct) return direct;
  return directVinOrSerialFromText(
    [lot?.title, lot?.description, lot?.details].map(cleanString).filter(Boolean).join(", ")
  );
}

function parseMileage(text: string): string {
  const match =
    text.match(/\bshowing\s+mileage\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
    text.match(/\bmileage\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
    text.match(/\bodometer\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
    text.match(/\b([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\s*(?:showing|on\s+odometer)\b/i);
  return match ? `${match[1]} ${match[2]}` : "";
}

function parseEngine(text: string): string {
  const explicit = text.match(/\bengine\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() || "";
  if (explicit && !/^(started|ran|manufacturer|model|hours|displacement)$/i.test(explicit)) return explicit;
  return text.match(/\b(\d+(?:\.\d+)?\s*l(?:itre|iter)?(?:\s+turbo)?[^,;\n]*)\b/i)?.[1]?.trim() || "";
}

function parseEngineDisplacement(text: string): string {
  const match =
    text.match(/\bengine\s+displacement\s*[:\-]?\s*(\d+(?:\.\d+)?\s*l)\b/i) ||
    text.match(/\bdisplacement\s*[:\-]?\s*(\d+(?:\.\d+)?\s*l)\b/i) ||
    text.match(/\b(\d+(?:\.\d+)?\s*l)\b/i);
  return match ? cleanString(match[1]).toUpperCase() : "";
}

function parseFuel(text: string): string {
  const match =
    text.match(/\bfuel\s+type\s*[:\-]?\s*([A-Za-z][A-Za-z /-]{2,24})\b/i) ||
    text.match(/\bfuel\b\s*[:\-]\s*([A-Za-z][A-Za-z /-]{2,24})\b/i) ||
    text.match(/\b(diesel|gasoline|gas|petrol|electric|hybrid|propane|natural gas)\b/i);
  const value = cleanString(match?.[1]);
  if (!value) return "";
  return /^gas$/i.test(value)
    ? "Gasoline"
    : value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function parseTransmission(text: string): string {
  const labelled =
    text.match(/\btransmission\s+type\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
    text.match(/\btransmission\b\s*[:\-]\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
    "";
  if (labelled) {
    if (/\bautomatic\b/i.test(labelled)) return "Automatic";
    if (/\bmanual\b/i.test(labelled)) return "Manual";
    if (/\bcvt\b/i.test(labelled)) return "CVT";
    return labelled;
  }
  if (/\bautomatic(?:\s+transmission)?\b/i.test(text)) return "Automatic";
  if (/\bmanual(?:\s+transmission)?\b/i.test(text)) return "Manual";
  if (/\bcvt\b/i.test(text)) return "CVT";
  return "";
}

function parseDrive(text: string): string {
  const labelled =
    text.match(/\bdrive\s+type\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
    // A bare label counts only with a separator, matching the renderer's rule:
    // "runs and drives" must not read as a drive type. Prose is read below.
    text.match(/\bdrive\b\s*[:\-]\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
    "";
  const match = (labelled || text).match(
    /\b(4x4|4wd|awd|fwd|rwd|4-wheel drive|four wheel drive|all wheel drive|front wheel drive|rear wheel drive)\b/i
  );
  return match ? match[1].toUpperCase() : labelled;
}

function parseColour(text: string): string {
  const labelled =
    text.match(/\bcolou?r\s*[:\-]?\s*([A-Za-z][A-Za-z /-]{2,24})\b/i)?.[1] ||
    text.match(/\bexterior\s+colou?r\s*[:\-]?\s*([A-Za-z][A-Za-z /-]{2,24})\b/i)?.[1] ||
    text.match(/\b(black|white|silver|grey|gray|red|blue|green|yellow|orange|brown|beige|tan|gold|purple|maroon)\b/i)?.[1] ||
    "";
  return labelled ? labelled.charAt(0).toUpperCase() + labelled.slice(1).toLowerCase() : "";
}

function parseDoorCount(text: string): string {
  return (
    text.match(/\bdoor\s+count\s*[:\-]?\s*(\d+)(?:\s*[- ]?\s*door)?\b/i)?.[1] ||
    text.match(/\b(\d+)\s*[- ]?\s*door\b/i)?.[1] ||
    ""
  );
}

function parseHours(text: string): string {
  return extractHourMeterReading(text);
}

function getSelectionValue(lot: any, key: "condition" | "completeness" | "legal"): string {
  const value = cleanString(
    normalizeAssetConditionSelectionValue(key, lot?.condition_report_selections?.[key])
  );
  return /^n\/?a$/i.test(value) ? "" : value;
}

function isDamageField(field: string): boolean {
  const key = normalizeKey(field);
  return key === "damage" || key === "damages" || key === "damageanalysis";
}

// This pass is deliberately fill-only. Submitted values are evidence from the exact
// asset and must outrank text inference, VIN metadata, and third-party web research.
function normalizeVisibleLotSpecs(lot: any): { lot: any; filled: string[]; vinFilled: string[] } {
  const clone = { ...(lot || {}) };
  const categorySpec = resolveCategorySpec(clone.categories);
  const fields = categorySpec?.fields?.length ? categorySpec.fields : [];
  /*
     Inference may fill a blank, never a deliberate deletion. The selection-
     driven writes below keep the full list on purpose: a Running Condition or
     Legal choice is the appraiser's own explicit input and stays authoritative
     (the closing normalization still applies the tombstones to every row).
  */
  const inferableFields = fields.filter((field) => !isAuctioneerSpecFieldDeleted(clone, field, fields));
  const specs = structuredSpecsToRecord(clone.condition_report_specs);
  const filled: string[] = [];
  const vinFilled: string[] = [];
  const text = [
    clone.title,
    clone.description,
    clone.details,
    clone.serial_number,
    clone.sn_vin,
    clone.serial_no_or_label,
  ].map(cleanString).filter(Boolean).join(", ");

  const serial = getLotVinOrSerial(clone);
  const rawConditionSelection = normalizeAssetConditionSelectionValue(
    "condition",
    clone?.condition_report_selections?.condition
  );
  const rawLegalSelection = normalizeAssetConditionSelectionValue(
    "legal",
    clone?.condition_report_selections?.legal
  );
  const completenessSelection = getSelectionValue(clone, "completeness");
  if (!isUsefulValue(clone.serial_number) && serial) clone.serial_number = serial;
  setSpecIfBlank(specs, inferableFields, [/^serialnumber$/, /\bvin\b/, /^sn$/], serial, filled);
  setSpecIfBlank(
    specs,
    fields,
    [/^year$/, /^modelyear$/, /^yearofmanufacture$/, /^manufactureyear$/],
    clone.year ?? clone.model_year ?? clone.modelYear,
    filled
  );
  setSpecFromSelection(specs, fields, [/^runningcondition$/, /^workingcondition$/], rawConditionSelection, filled);
  setSpecIfBlank(specs, inferableFields, [/haskey/, /keyspresent/, /^keys$/], /has keys?/i.test(completenessSelection) ? "Yes" : "", filled);
  setSpecIfBlank(specs, inferableFields, [/missingparts/], /missing parts/i.test(completenessSelection) ? "Yes" : "", filled);
  setSpecIfBlank(specs, inferableFields, [/incompleteunit/], /incomplete unit/i.test(completenessSelection) ? "Yes" : "", filled);
  setLegalSpecFromSelection(specs, fields, rawLegalSelection, filled);
  setSpecIfBlank(specs, inferableFields, [/showingmileage/, /mileage/, /odometer/], parseMileage(text), filled);
  setSpecIfBlank(specs, inferableFields, [/showinghours/, /hours/], parseHours(text), filled);
  setSpecIfBlank(specs, inferableFields, [/^engine$/, /^enginemodel$/, /^enginehp$/, /^enginehp/], parseEngine(text), filled);
  setSpecIfBlank(specs, inferableFields, [/enginedisplacement/, /^displacement$/], parseEngineDisplacement(text), filled);
  setSpecIfBlank(specs, inferableFields, [/fueltype/, /^fuel$/], parseFuel(text), filled);
  setSpecIfBlank(specs, inferableFields, [/transmissiontype/, /^transmission$/], parseTransmission(text), filled);
  setSpecIfBlank(specs, inferableFields, [/drivetype/, /^drive$/], parseDrive(text), filled);
  setSpecIfBlank(specs, inferableFields, [/^colour$/, /^color$/, /exteriorcolour/, /exteriorcolor/], parseColour(text), filled);
  setSpecIfBlank(specs, inferableFields, [/doorcount/, /^doors$/], parseDoorCount(text), filled);
  setSpecIfBlank(specs, inferableFields, [/turbocharged/], /\bturbo(?:charged)?\b/i.test(text) ? "Yes" : "", filled);

  const decoded = clone.vinDecoded || clone.vin_decoded || {};
  setSpecIfBlank(specs, inferableFields, [/^serialnumber$/, /\bvin\b/, /^sn$/], decoded?.vin ? `VIN: ${decoded.vin}` : "", vinFilled);
  setSpecIfBlank(
    specs,
    fields,
    [/^year$/, /^modelyear$/, /^yearofmanufacture$/, /^manufactureyear$/],
    decoded?.year ?? decoded?.ModelYear,
    vinFilled
  );
  setSpecIfBlank(specs, inferableFields, [/trimlevel/, /^trim$/], decoded?.trim, vinFilled);
  setSpecIfBlank(specs, inferableFields, [/bodyclass/, /^body$/], decoded?.bodyClass, vinFilled);
  setSpecIfBlank(specs, inferableFields, [/drivetype/, /^drive$/], decoded?.driveType, vinFilled);
  setSpecIfBlank(specs, inferableFields, [/enginecylinders/], decoded?.engineCylinders, vinFilled);
  setSpecIfBlank(specs, inferableFields, [/enginedisplacement/, /^displacement$/], decoded?.displacementL ? `${decoded.displacementL}L` : "", vinFilled);
  setSpecIfBlank(specs, inferableFields, [/fueltype/, /^fuel$/], decoded?.fuelType, vinFilled);
  setSpecIfBlank(specs, inferableFields, [/transmissiontype/, /^transmission$/], decoded?.transmissionStyle || decoded?.transmission, vinFilled);
  setSpecIfBlank(specs, inferableFields, [/transmissionspeeds/], decoded?.transmissionSpeeds, vinFilled);
  setSpecIfBlank(specs, inferableFields, [/vehicletype/], decoded?.vehicleType, vinFilled);

  clone.condition_report_specs =
    Object.keys(specs).length > 0 || rawLegalSelection
      ? specs
      : clone.condition_report_specs;
  return { lot: clone, filled, vinFilled };
}

function missingApplicableFields(lot: any): string[] {
  const spec = resolveCategorySpec(lot?.categories);
  if (!spec?.fields?.length) return [];
  const rawLegalSelection = normalizeAssetConditionSelectionValue(
    "legal",
    lot?.condition_report_selections?.legal
  );
  const clearedLegalFieldKeys = isSelectionNa(rawLegalSelection)
    ? legalSelectionSpecFieldKeys(spec.fields)
    : new Set<string>();
  const specs = structuredSpecsToRecord(lot?.condition_report_specs);
  // A removed field is not missing: researching it again would pay to undo the
  // appraiser's decision and then present the result as new evidence.
  return spec.fields.filter(
    (field) =>
      !isDamageField(field) &&
      !clearedLegalFieldKeys.has(normalizeKey(field)) &&
      !isAuctioneerSpecFieldDeleted(lot, field, spec.fields) &&
      !getExistingSpecValue(specs, field)
  );
}

function splitIntoFixedSizeChunks<T>(items: T[], chunkSize: number): T[][] {
  if (items.length === 0) return [];
  const size = Math.max(1, chunkSize);
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

// Weak identities are not cached: sharing research between two generic descriptions is
// more damaging than repeating a provider call. A complete VIN is the strongest key.
function buildCacheKey(lot: any): string {
  const category = cleanString(lot?.categories);
  const serial = getLotVinOrSerial(lot);
  const vin = extractVinFromText(serial) || serial.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i)?.[0] || "";
  if (vin && vin.length === 17 && !vin.includes("*")) {
    return `vin:${vin.toUpperCase()}:${normalizeKey(category)}`;
  }

  const identityText = [lot?.title, lot?.description, lot?.details]
    .map(cleanString)
    .filter(Boolean)
    .join(" ");
  const year = identityText.match(/\b(19[8-9]\d|20[0-4]\d)\b/)?.[1] || "";
  const titleKey = normalizeKey(lot?.title || identityText).slice(0, 90);
  if (!year && titleKey.length < 12) return "";
  return `identity:${year}:${titleKey}:${normalizeKey(category)}`;
}

function buildWebPrompt(input: {
  lot: any;
  category: string;
  fields: string[];
  currency?: string;
  location?: string;
}) {
  return [
    "Research verified auction/specification values for one Lot Listing row.",
    "Return JSON only. Use web sources. Fill only fields that can be verified from the provided visible data, VIN decode data, manufacturer pages, NHTSA/vPIC, credible manuals/spec pages, or public listings that match the same year/make/model/trim.",
    "Do not guess. Do not fill current condition, damage, options, mileage, keys, title status, or serial values from unrelated listings unless they are visible/provided for this exact lot. For each requested field that cannot be verified, return a condition_report_specs entry with value exactly \"Not Found\" and also put that field in unresolved_fields.",
    "If a field value would only say something is visible, return \"Yes\". If it would only say something is not visible, return \"No\".",
    `Category: ${input.category}`,
    `Currency: ${input.currency || ""}`,
    `Location: ${input.location || ""}`,
    `Requested exact field labels:\n${input.fields.map((field) => `- ${field}`).join("\n")}`,
    `Lot JSON:\n${JSON.stringify({
      lot_number: input.lot?.lot_number,
      title: input.lot?.title,
      description: input.lot?.description,
      details: input.lot?.details,
      serial_number: input.lot?.serial_number,
      categories: input.lot?.categories,
      condition_report_specs: input.lot?.condition_report_specs,
      vinDecoded: input.lot?.vinDecoded || input.lot?.vin_decoded,
    }, null, 2)}`,
  ].join("\n\n");
}

// Deployments span both generations of the Responses web-search tool. Retry only the
// tool-compatibility failure; authentication, quota, and model errors must remain visible.
async function createWebSearchResponse(prompt: string, schema: any) {
  const model =
    process.env.AUCTIONEER_IMPORT_ENRICHMENT_MODEL ||
    process.env.LOT_LISTING_ENRICHMENT_MODEL ||
    process.env.OPENAI_MODEL_TEXT ||
    "gpt-5";
  const baseRequest = {
    model,
    reasoning: { effort: "low" },
    tool_choice: "required",
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "lot_listing_spec_enrichment",
        strict: true,
        schema,
      },
    },
  };

  try {
    return await openai.responses.create({
      ...baseRequest,
      tools: [{ type: "web_search", external_web_access: true, search_context_size: "high" }],
    } as any);
  } catch (error: any) {
    const message = cleanString(error?.message || error);
    if (!/web_search|tool/i.test(message)) throw error;
    return openai.responses.create({
      ...baseRequest,
      tools: [{ type: "web_search_preview", search_context_size: "high" }],
    } as any);
  }
}

async function enrichChunkWithWeb(input: {
  lot: any;
  category: string;
  fields: string[];
  currency?: string;
  location?: string;
}): Promise<{
  specs: SpecRecord;
  unresolvedFields: string[];
  sources: Array<{ title?: string; url: string; field?: string }>;
}> {
  const schema = {
    type: "object",
    properties: {
      condition_report_specs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string", enum: input.fields },
            value: { type: "string" },
            source_url: { type: "string" },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["field", "value", "source_url", "confidence"],
          additionalProperties: false,
        },
      },
      unresolved_fields: {
        type: "array",
        items: { type: "string", enum: input.fields },
      },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
          },
          required: ["title", "url"],
          additionalProperties: false,
        },
      },
    },
    required: ["condition_report_specs", "unresolved_fields", "sources"],
    additionalProperties: false,
  };

  const response = await createWebSearchResponse(buildWebPrompt(input), schema);
  const parsed = JSON.parse(cleanString((response as any)?.output_text || "{}"));
  const specs: SpecRecord = {};
  const sources: Array<{ title?: string; url: string; field?: string }> = [];
  const unresolved = new Set<string>(
    Array.isArray(parsed?.unresolved_fields) ? parsed.unresolved_fields.map(cleanString) : []
  );

  for (const entry of Array.isArray(parsed?.condition_report_specs)
    ? parsed.condition_report_specs
    : []) {
    const field = cleanString(entry?.field);
    const value = cleanString(entry?.value);
    const sourceUrl = cleanString(entry?.source_url);
    const confidence = cleanString(entry?.confidence).toLowerCase();
    if (!input.fields.includes(field) || !isUsefulValue(value) || !sourceUrl) {
      if (field) unresolved.add(field);
      continue;
    }
    if (confidence !== "medium" && confidence !== "high") {
      unresolved.add(field);
      continue;
    }
    specs[field] = value;
    sources.push({ field, url: sourceUrl });
    unresolved.delete(field);
  }

  for (const source of Array.isArray(parsed?.sources) ? parsed.sources : []) {
    const url = cleanString(source?.url);
    if (!url) continue;
    sources.push({ title: cleanString(source?.title) || undefined, url });
  }

  return {
    specs,
    unresolvedFields: Array.from(unresolved).filter((field) => input.fields.includes(field)),
    sources,
  };
}

function mergeSpecsPreservingExisting(lot: any, incoming: SpecRecord, filled: string[]): any {
  const specs = structuredSpecsToRecord(lot?.condition_report_specs);
  const categoryFields = resolveCategorySpec(lot?.categories)?.fields ?? [];
  for (const [field, value] of Object.entries(incoming)) {
    const key = normalizeKey(field);
    if (!key || !isUsefulValue(value)) continue;
    // A cached or returned value for a removed field stays out; the tombstone wins.
    if (isAuctioneerSpecFieldDeleted(lot, field, categoryFields)) continue;
    const existingKey = Object.keys(specs).find((candidate) => normalizeKey(candidate) === key);
    if (existingKey && isUsefulValue(specs[existingKey])) continue;
    specs[existingKey || field] = value;
    filled.push(field);
  }
  return { ...lot, condition_report_specs: Object.keys(specs).length > 0 ? specs : lot?.condition_report_specs };
}

export async function enrichLotListingSpecs(input: {
  lots: any[];
  currency?: string;
  location?: string;
  mode?: "pictureOnly" | "webEnriched";
}): Promise<{ lots: any[]; analyses: LotListingSpecEnrichmentAnalysis[] }> {
  // Work on top-level copies. Nested catalogue items are not deep-cloned, so enrichment
  // may still update item arrays/records shared with the caller's original payload.
  const sourceLots = Array.isArray(input.lots) ? input.lots : [];
  let lots = sourceLots.map((lot) => ({ ...(lot || {}) }));
  const enabled =
    input.mode === "pictureOnly"
      ? false
      : await isAuctioneerSpecWebSearchEnabled();

  if (enabled) {
    try {
      lots = await enrichLotsWithVin(lots, "per_item");
    } catch (error) {
      // VIN is an enrichment source, not a transaction prerequisite. Visible values and
      // web evidence can still produce a useful partial condition report.
      console.warn("[LotListing] VIN decode enrichment failed; continuing with visible specs:", error);
    }
  } else {
    // The deterministic fallback is the free/offline second layer. When vPIC is
    // enabled, enrichLotsWithVin applies the same fallback only after vPIC has
    // had the opportunity to provide an authoritative model year.
    lots = applyVinModelYearFallback(lots);
  }

  const lotConcurrency = getPositiveIntEnv(
    "AUCTIONEER_IMPORT_ENRICHMENT_LOT_CONCURRENCY",
    getPositiveIntEnv("LOT_LISTING_ENRICHMENT_LOT_CONCURRENCY", 4)
  );
  const chunkConcurrency = getPositiveIntEnv(
    "AUCTIONEER_IMPORT_ENRICHMENT_CHUNK_CONCURRENCY",
    getPositiveIntEnv("LOT_LISTING_ENRICHMENT_CHUNK_CONCURRENCY", 5)
  );
  const fieldsPerChunk = getPositiveIntEnv(
    "AUCTIONEER_IMPORT_ENRICHMENT_FIELDS_PER_CHUNK",
    getPositiveIntEnv("LOT_LISTING_ENRICHMENT_FIELDS_PER_CHUNK", 20)
  );

  // Separate limits bound total lots and field chunks. This keeps latency reasonable
  // without multiplying a large import into an unbounded number of paid requests.
  const enriched = await mapWithConcurrency(
    lots,
    lotConcurrency,
    async (lot, index): Promise<{ lot: any; analysis: LotListingSpecEnrichmentAnalysis }> => {
      const visibleResult = normalizeVisibleLotSpecs(lot);
      let currentLot = visibleResult.lot;
      const category = cleanString(currentLot?.categories);
      const analysis: LotListingSpecEnrichmentAnalysis = {
        lot_index: index,
        lot_number: cleanString(currentLot?.lot_number || currentLot?.lot_id || index + 1),
        category,
        status: "skipped",
        fields_per_chunk: fieldsPerChunk,
        chunks_run: [],
        visible_filled: visibleResult.filled,
        vin_filled: visibleResult.vinFilled,
        web_filled: [],
        unresolved_fields: [],
        sources: [],
      };

      let missing = missingApplicableFields(currentLot);
      if (!enabled || missing.length === 0) {
        analysis.status = missing.length === 0 ? "completed" : "skipped";
        analysis.unresolved_fields = missing;
        return { lot: currentLot, analysis };
      }

      const cacheKey = buildCacheKey(currentLot);
      analysis.cache_key = cacheKey || undefined;
      if (!cacheKey) {
        analysis.status = "partial";
        analysis.unresolved_fields = missing;
        return { lot: currentLot, analysis };
      }

      // The cache is process-local by design: it removes duplicate research inside/between
      // nearby imports without becoming durable evidence that can outlive source changes.
      const cached = enrichmentCache.get(cacheKey);
      if (cached) {
        const webFilled: string[] = [];
        currentLot = mergeSpecsPreservingExisting(currentLot, cached.specs, webFilled);
        analysis.cache_hit = true;
        analysis.web_filled = webFilled;
        analysis.sources = cached.sources;
        missing = missingApplicableFields(currentLot);
        if (missing.length === 0) {
          analysis.unresolved_fields = [];
          analysis.status = "completed";
          return { lot: currentLot, analysis };
        }
      } else {
        analysis.cache_hit = false;
      }

      const chunks = splitIntoFixedSizeChunks(missing, fieldsPerChunk);
      const chunkResults = await mapWithConcurrency(
        chunks,
        chunkConcurrency,
        async (fields, chunkIndex) => {
          try {
            const result = await enrichChunkWithWeb({
              lot: currentLot,
              category,
              fields,
              currency: input.currency,
              location: input.location,
            });
            const filledFields = Object.keys(result.specs).filter((field) =>
              isUsefulValue(result.specs[field])
            );
            return {
              specs: result.specs,
              unresolvedFields: result.unresolvedFields,
              sources: result.sources,
              chunk: {
                index: chunkIndex + 1,
                fields,
                status:
                  result.unresolvedFields.length === 0
                    ? "completed"
                    : "partial",
                filled_fields: filledFields,
                unresolved_fields: result.unresolvedFields,
                sources: result.sources,
              } as LotListingSpecEnrichmentAnalysis["chunks_run"][number],
            };
          } catch (error: any) {
            const message = cleanString(error?.message || error);
            console.warn(
              `[LotListing] Web spec enrichment chunk ${chunkIndex + 1} failed for lot ${analysis.lot_number}:`,
              error
            );
            return {
              specs: {} as SpecRecord,
              unresolvedFields: fields,
              sources: [] as Array<{ title?: string; url: string; field?: string }>,
              chunk: {
                index: chunkIndex + 1,
                fields,
                status: "failed" as const,
                filled_fields: [],
                unresolved_fields: fields,
                sources: [],
                error: message,
              },
            };
          }
        }
      );

      const webSpecs: SpecRecord = {};
      const unresolved = new Set<string>();
      const sources: Array<{ title?: string; url: string; field?: string }> = [
        ...analysis.sources,
      ];
      for (const result of chunkResults) {
        Object.assign(webSpecs, result.specs);
        result.unresolvedFields.forEach((field) => unresolved.add(field));
        sources.push(...result.sources);
      }

      // Merge all successful chunks even when siblings fail. The returned diagnostics
      // preserve unresolved fields so administrators can retry or complete them manually.
      const webFilled: string[] = [];
      currentLot = mergeSpecsPreservingExisting(currentLot, webSpecs, webFilled);
      const stillMissing = missingApplicableFields(currentLot);
      stillMissing.forEach((field) => unresolved.add(field));

      enrichmentCache.set(cacheKey, {
        specs: { ...(cached?.specs || {}), ...webSpecs },
        sources,
        unresolvedFields: Array.from(unresolved),
      });

      const failedChunks = chunkResults.filter((result) => result.chunk.status === "failed");
      analysis.web_filled = Array.from(new Set([...analysis.web_filled, ...webFilled]));
      analysis.unresolved_fields = Array.from(unresolved);
      analysis.sources = sources;
      analysis.chunks_run = chunkResults.map((result) => result.chunk);
      analysis.status =
        analysis.unresolved_fields.length === 0
          ? "completed"
          : failedChunks.length === chunkResults.length && analysis.web_filled.length === 0
            ? "failed"
            : "partial";
      if (failedChunks.length > 0) {
        analysis.error = `${failedChunks.length} enrichment chunk(s) failed`;
      }

      return { lot: currentLot, analysis };
    }
  );

  return {
    lots: enriched.map((entry) =>
      normalizeAuctioneerLotSpecs(entry.lot, { includeMissing: enabled })
    ),
    analyses: enriched.map((entry) => entry.analysis),
  };
}

export const enrichAuctioneerImportSpecs = enrichLotListingSpecs;
