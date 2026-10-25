import { extractVinFromText } from "../vehicleApiService.js";
import { toTitleCaseWords } from "../docx/builders/utils.js";
import {
  addWorksheetFromRows,
  applyListValidationToColumn,
  getWorksheetColumnWidthsFromRows,
  setWorksheetColumnWidths,
  workbookToBuffer,
} from "../../utils/excel.js";
import ExcelJS from "exceljs";
import {
  DAMAGE_ANALYSIS_LABEL,
  buildReportDamageAnalysis,
  deriveLotDamageAnalysis,
  formatDamageAnalysisLines,
  sanitizeDamageAnalysisText,
} from "../../utils/assetDamageAnalysis.js";
import {
  allowedCategories,
  assetCategorySpecs,
  masterSpecHeaders,
} from "../../utils/assetCategorySpecs.js";
import {
  AUCTIONEER_NOT_FOUND,
  buildAuctioneerSpecRows,
  collectAuctioneerSpecRecord,
  normalizeAuctioneerLotSpecs,
  normalizeVisiblePresenceValue,
  resolveAuctioneerSerialOverride,
  reviewedAuctioneerItemSpecState,
  shouldDisplayAuctioneerSpecRow,
  stripRedundantSerialLabel,
} from "../../utils/auctioneerSpecRows.js";
import {
  normalizeLotsForBusinessRules,
  stripLeadingDescriptionMarker,
} from "../../utils/previewLotNormalization.js";
import { isLotDamageAnalysisEligible } from "../../utils/lotDamagePolicy.js";
import {
  buildCrDisclaimersHtmlForLot,
  getCrDisclaimersForLot,
} from "../../utils/crDisclaimers.js";
import {
  AUCTION_LOCATION_COORDINATES,
  AUCTION_LOCATION_LIST,
} from "../../utils/auctionLocations.js";

/**
 * Produces the auction-import workbook, not a generic data export. The visible
 * column order, HTML fragments, support-sheet ranges, and validation formulas
 * form a downstream import contract; keep them stable unless the consumer is
 * migrated at the same time.
 *
 * Assembly is intentionally staged: normalize legacy report shapes, enrich
 * category-specific specifications, flatten lots/items into canonical rows,
 * then attach workbook-only validation and lookup infrastructure.
 */
const categorySpecByName = new Map(
  assetCategorySpecs.map((spec) => [
    normalizeSpecKey(spec.childCategory),
    spec,
  ])
);
const categoryNameByNormalizedName = new Map(
  allowedCategories.map((category) => [normalizeSpecKey(category), category])
);
const UNRESERVED_DESCRIPTION_HTML =
  "<br/><span style='color:#FFFFFF;background-color:#FF0000'>UNRESERVED</span>";
const ASSET_XLSX_HEADERS = [
  "Lot #",
  "Description",
  "Serial Number",
  "Categories",
  "Bid Increment",
  "Opening Bid",
  "Contract #",
  "Quantity",
  "Must Take",
  "Show On Website",
  "Close Date",
  "Location",
  "Latitude",
  "Longitude",
  "Item Condition",
  "Lotted By",
  "Condition Report",
  "Schedule A",
] as const;

type AssetXlsxHeader = (typeof ASSET_XLSX_HEADERS)[number];

type AssetXlsxGenerationOptions = {
  includeScheduleAColumn?: boolean;
};

function normalizeSpecKey(value: any): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainObject(value: any): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getFirstText(...values: any[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function hasOwnField(value: any, field: string): boolean {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, field));
}

function isUsefulSpecValue(value: any): boolean {
  const text = String(value ?? "").trim();
  return (
    !!text &&
    !/^(?:false|no|n|0|n\/a|na|none|null|unknown|not\s+(?:visible|found|available|applicable)|tbd)$/i.test(text) &&
    !isBoilerplateAuctionText(text)
  );
}

function isMissingOrNegativeCellValue(value: unknown): boolean {
  const text = String(value ?? "").trim();
  return (
    !text ||
    /^(?:false|no|n|0|n\/a|na|none|null|unknown|not\s*(?:visible|found|available|applicable)|not\s+tested|tbd|missing)$/i.test(text)
  );
}

function isBoilerplateAuctionText(value: any): boolean {
  const text = String(value ?? "").trim();
  return (
    /title clearance clarification fee/i.test(text) ||
    /applied to your invoice/i.test(text) ||
    /over and above the purchase price/i.test(text) ||
    /applicable taxes/i.test(text) ||
    /following the close of the sale/i.test(text)
  );
}

function getStructuredSpecs(rec: any): Record<string, any> {
  return collectAuctioneerSpecRecord(rec);
}

// Spec keys arrive from AI output, saved previews, and auctioneer imports with
// different casing and spelling. Matching variants here preserves one canonical
// workbook schema without discarding an explicitly supplied value.
function getObjectValueByHeader(
  source: Record<string, any>,
  header: string
): string {
  if (!source) return "";
  if (source[header] !== undefined && source[header] !== null) {
    const value = String(source[header]).trim();
    return isUsefulSpecValue(value) ? value : "";
  }

  const normalizedHeaders = getFieldVariants(header).map(normalizeSpecKey);
  const matchingKey = Object.keys(source).find(
    (key) => normalizedHeaders.includes(normalizeSpecKey(key))
  );
  const value = matchingKey ? source[matchingKey] : undefined;
  if (value === undefined || value === null) return "";
  const text = String(value).trim();
  return isUsefulSpecValue(text) ? text : "";
}

function splitConditionSegments(...values: any[]): string[] {
  const seen = new Set<string>();
  const segments: string[] = [];

  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) continue;

    for (const rawSegment of text.split(/[;\n]+|,(?=\s*[A-Z])/)) {
      const segment = stripLeadingDescriptionMarker(rawSegment);
      if (!segment) continue;
      if (isBoilerplateAuctionText(segment)) continue;
      const key = segment.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      segments.push(segment);
    }
  }

  return segments;
}

function buildConditionReportDetails(rec: any, lotNumber: string): string {
  const segments = splitConditionSegments(rec?.description, rec?.details);
  const lotSuffix = lotNumber ? `Lot #: ${lotNumber}` : "";

  if (lotSuffix) {
    const lotSuffixKey = lotSuffix.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const alreadyHasLotSuffix = segments.some(
      (segment) => segment.toLowerCase().replace(/[^a-z0-9]+/g, "") === lotSuffixKey
    );
    if (!alreadyHasLotSuffix) segments.push(lotSuffix);
  }

  return segments.join(", ");
}

function buildAuctionDescription(rec: any): string {
  // Owner decision 2026-10-14: the workbook's Description column shows the
  // saved Title. Keep legacy fallback text and existing import-safe cleaning,
  // but never rewrite the independent narrative or reviewed specifications.
  const source = getFirstText(
    rec?.excel_item_description,
    rec?.title,
    rec?.description,
    rec?.auction_description,
    rec?.short_description
  );
  const plainSource = stripConditionReportHtml(
    source
      .replace(/<br\s*\/?>\s*<span[^>]*>\s*UNRESERVED\s*<\/span>/gi, " ")
      .replace(/\bUNRESERVED\b/gi, " ")
  );
  // Export the complete reviewed text. The concise AI-ingress limit must not
  // discard identifying details from the saved text during file generation.
  const cleaned = stripLeadingDescriptionMarker(plainSource);
  // The shared cleaner trims trailing punctuation left behind by removed
  // condition labels; a saved sentence keeps its own closing full stop.
  return cleaned && plainSource.endsWith(`${cleaned}.`) ? `${cleaned}.` : cleaned;
}

function getFieldVariants(field: string): string[] {
  const baseField = field.replace(/\s*\([^)]*\)/g, "").trim();
  const variants = [field, baseField].filter(Boolean);
  for (const variant of [...variants]) {
    if (/\bcolor\b/i.test(variant)) variants.push(variant.replace(/\bColor\b/g, "Colour"));
    if (/\bcolour\b/i.test(variant)) variants.push(variant.replace(/\bColour\b/g, "Color"));
  }
  return Array.from(new Set(variants));
}

function parseSpecValueFromText(text: string, field: string): string {
  if (!text) return "";
  const parts = text
    .split(/[;\n]+|,(?=\s*[A-Z])/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const variant of getFieldVariants(field)) {
    const startPattern = new RegExp(
      `^${escapeRegExp(variant)}(?:\\s*[:#-]\\s*|\\s+)(.+)$`,
      "i"
    );
    const partMatch = parts
      .map((part) => part.match(startPattern)?.[1]?.trim() || "")
      .find(Boolean);
    if (partMatch) return partMatch;

    const inlinePattern = new RegExp(
      `(?:^|[,;\\n])\\s*${escapeRegExp(variant)}(?:\\s*[:#-]\\s*|\\s+)([^,;\\n]+)`,
      "i"
    );
    const inlineMatch = text.match(inlinePattern)?.[1]?.trim() || "";
    if (inlineMatch) return inlineMatch;
  }

  const normalizedField = normalizeSpecKey(field);
  const plainText = text.replace(/\s+/g, " ").trim();

  if (normalizedField.includes("doorcount") || normalizedField === "doors") {
    const doorMatch = plainText.match(/\b(\d+)\s*[- ]?\s*door\b/i);
    if (doorMatch) return doorMatch[1];
  }

  if (
    normalizedField.includes("showingmileage") ||
    normalizedField.includes("odometer") ||
    normalizedField.includes("mileage")
  ) {
    const mileageMatch =
      plainText.match(/\b([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\s*(?:showing)?\b/i) ||
      plainText.match(/\bshowing\s+([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i);
    if (mileageMatch) return `${mileageMatch[1]} ${mileageMatch[2]}`;
  }

  if (normalizedField.includes("transmissiontype") || normalizedField === "transmission") {
    if (/\bautomatic(?:\s+transmission)?\b/i.test(plainText)) return "Automatic";
    if (/\bmanual(?:\s+transmission)?\b/i.test(plainText)) return "Manual";
    if (/\bcvt\b/i.test(plainText)) return "CVT";
  }

  if (normalizedField.includes("drivetype") || normalizedField === "drive") {
    const driveMatch = plainText.match(
      /\b(4x4|4wd|awd|fwd|rwd|4-wheel drive|four wheel drive|all wheel drive|front wheel drive|rear wheel drive)\b/i
    );
    if (driveMatch) return driveMatch[1].toUpperCase();
  }

  if (normalizedField.includes("fueltype") || normalizedField === "fuel") {
    const fuelMatch = plainText.match(/\b(diesel|gasoline|gas|petrol|electric|hybrid|propane|natural gas)\b/i);
    if (fuelMatch) {
      const fuel = fuelMatch[1].toLowerCase();
      if (fuel === "gas") return "Gasoline";
      return fuel.charAt(0).toUpperCase() + fuel.slice(1);
    }
  }

  if (normalizedField.includes("enginedisplacement")) {
    const displacementMatch = plainText.match(/\b(\d+(?:\.\d+)?\s*l)\b/i);
    if (displacementMatch) return displacementMatch[1].toUpperCase();
  }

  if (normalizedField.includes("turbocharged")) {
    if (/\bturbocharged\b/i.test(plainText)) return "Yes";
  }

  if (
    normalizedField === "engine" ||
    normalizedField.includes("enginemodel") ||
    normalizedField.includes("enginemanufacturer")
  ) {
    const engineMatch = plainText.match(
      /\b((?:\d+(?:\.\d+)?\s*l|v\d|i\d|[\w.-]+\s+cylinder)[^,;]*engine)\b/i
    );
    if (engineMatch) return engineMatch[1].trim();
  }

  if (
    normalizedField === "colour" ||
    normalizedField === "color" ||
    normalizedField === "exteriorcolour" ||
    normalizedField === "exteriorcolor"
  ) {
    const colorMatch =
      plainText.match(/\bcolou?r\s*[:\-]?\s*([A-Za-z][A-Za-z /-]{2,24})\b/i) ||
      plainText.match(/\b(black|white|silver|grey|gray|red|blue|green|yellow|orange|brown|beige|tan|gold|purple|maroon)\b/i);
    if (colorMatch) {
      const color = (colorMatch[1] || "").trim();
      return color.charAt(0).toUpperCase() + color.slice(1).toLowerCase();
    }
  }

  return "";
}

function parseSerialOrVinFromText(text: string): string {
  const vin = extractVinFromText(text);
  if (vin) return `VIN: ${vin}`;

  const labelledVinMatch = text.match(
    /\bvin(?:\s*[:#-]\s*|\s+)([A-HJ-NPR-Z0-9*]{8,18})\b/i
  );
  if (labelledVinMatch?.[1]) return `VIN: ${labelledVinMatch[1].toUpperCase()}`;

  const serialMatch = text.match(
    /\b(?:serial(?:\s*(?:number|no\.?|#))?|s\/n|sn)(?:\s*[:#-]\s*|\s+)([A-Z0-9*.-]{4,32})\b/i
  );
  if (!serialMatch) return "";
  const value = String(serialMatch[1] || "").trim();
  if (!value || /^(number|no|sn|serial)$/i.test(value)) return "";
  return `SN: ${value}`;
}

function cleanSerialCandidate(value: unknown): string {
  const text = String(value ?? "").trim();
  if (isMissingOrNegativeCellValue(text)) return "";
  if (/^(?:vin|sn|s\/n|serial(?:\s*(?:number|no\.?|#))?)\s*[:#-]?\s*$/i.test(text)) {
    return "";
  }
  return text;
}

function getDecodedVinValue(rec: any, key: string): string {
  const decoded = rec?.vinDecoded || rec?.vin_decoded || rec?.vinDecode || rec?.vin_decode;
  if (!decoded || typeof decoded !== "object") return "";
  const value = decoded[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

function deriveSerialFromRecord(rec: any): string {
  const override = resolveAuctioneerSerialOverride(rec);
  if (override.found) return override.value;
  const structuredSpecs = getStructuredSpecs(rec);
  const decodedVin = getDecodedVinValue(rec, "vin");
  const decodedVinLabel = decodedVin ? `VIN: ${decodedVin}` : "";
  const serialCandidates = [
    rec?.serial_number,
    rec?.sn_vin,
    rec?.serial_no_or_label,
    rec?.vin,
    rec?.sn,
    decodedVinLabel,
    getObjectValueByHeader(structuredSpecs, "Serial Number"),
    getObjectValueByHeader(structuredSpecs, "VIN"),
    getObjectValueByHeader(structuredSpecs, "SN"),
  ];
  for (const candidate of serialCandidates) {
    const cleanSerial = cleanSerialCandidate(candidate);
    if (cleanSerial) return cleanSerial;
  }
  const serialText = [
    rec?.serial_number,
    rec?.sn_vin,
    rec?.serial_no_or_label,
    rec?.details,
    rec?.description,
    rec?.title,
  ]
    .filter(Boolean)
    .join(" ");
  const found = extractVinFromText(serialText);
  if (found) return `VIN: ${found}`;
  return parseSerialOrVinFromText(serialText);
}

function findApplicableSpecField(fields: string[], matchers: RegExp[]): string {
  return (
    fields.find((field) => {
      const key = normalizeSpecKey(field);
      return matchers.some((matcher) => matcher.test(key));
    }) || ""
  );
}

function setAugmentedSpec(
  specs: Record<string, any>,
  fields: string[],
  matchers: RegExp[],
  value: any
) {
  const cleanValue = String(value ?? "").trim();
  if (!cleanValue || /^(n\/a|na|none|null|unknown|not visible|not found)$/i.test(cleanValue)) {
    return;
  }
  const field = findApplicableSpecField(fields, matchers);
  if (!field || getObjectValueByHeader(specs, field)) return;
  specs[field] = cleanValue;
}

function parseVisibleMileage(text: string): string {
  const match =
    text.match(/\bshowing\s+mileage\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
    text.match(/\bmileage\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
    text.match(/\bodometer\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
    text.match(/\b([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\s*(?:showing|on\s+odometer)\b/i);
  return match ? `${match[1]} ${match[2]}` : "";
}

function parseVisibleEngine(text: string): string {
  const explicit = text.match(/\bengine\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() || "";
  if (explicit && !/^(started|ran|manufacturer|model|hours|displacement)$/i.test(explicit)) {
    return explicit;
  }
  const displacement = text.match(/\b(\d+(?:\.\d+)?\s*l(?:itre|iter)?(?:\s+turbo)?[^,;\n]*)\b/i)?.[1]?.trim();
  return displacement || "";
}

function parseVisibleEngineDisplacement(text: string): string {
  const match =
    text.match(/\bengine\s+displacement\s*[:\-]?\s*(\d+(?:\.\d+)?\s*l)\b/i) ||
    text.match(/\bdisplacement\s*[:\-]?\s*(\d+(?:\.\d+)?\s*l)\b/i) ||
    text.match(/\b(\d+(?:\.\d+)?\s*l)\b/i);
  return match ? String(match[1]).toUpperCase() : "";
}

function parseVisibleFuel(text: string): string {
  const match =
    text.match(/\bfuel\s+type\s*[:\-]?\s*([A-Za-z][A-Za-z /-]{2,24})\b/i) ||
    text.match(/\bfuel\s*[:\-]?\s*([A-Za-z][A-Za-z /-]{2,24})\b/i) ||
    text.match(/\b(diesel|gasoline|gas|petrol|electric|hybrid|propane|natural gas)\b/i);
  const value = match?.[1]?.trim() || "";
  if (!value) return "";
  if (/^gas$/i.test(value)) return "Gasoline";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function parseVisibleTransmission(text: string): string {
  const labelled =
    text.match(/\btransmission\s+type\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
    text.match(/\btransmission\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
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

function parseVisibleDrive(text: string): string {
  const labelled =
    text.match(/\bdrive\s+type\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
    text.match(/\bdrive\s*[:\-]?\s*([^,;\n]+)\b/i)?.[1]?.trim() ||
    "";
  const source = labelled || text;
  const match = source.match(
    /\b(4x4|4wd|awd|fwd|rwd|4-wheel drive|four wheel drive|all wheel drive|front wheel drive|rear wheel drive)\b/i
  );
  return match ? match[1].toUpperCase() : labelled;
}

function parseVisibleColour(text: string): string {
  const match =
    text.match(/\bcolou?r\s*[:\-]?\s*([A-Za-z][A-Za-z /-]{2,24})\b/i) ||
    text.match(/\bexterior\s+colou?r\s*[:\-]?\s*([A-Za-z][A-Za-z /-]{2,24})\b/i);
  const value = match?.[1]?.trim() || "";
  if (value) return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  const fallback = text.match(/\b(black|white|silver|grey|gray|red|blue|green|yellow|orange|brown|beige|tan|gold|purple|maroon)\b/i)?.[1] || "";
  return fallback ? fallback.charAt(0).toUpperCase() + fallback.slice(1).toLowerCase() : "";
}

function parseVisibleDoorCount(text: string): string {
  const match =
    text.match(/\bdoor\s+count\s*[:\-]?\s*(\d+)(?:\s*[- ]?\s*door)?\b/i) ||
    text.match(/\b(\d+)\s*[- ]?\s*door\b/i);
  return match?.[1] || "";
}

function parseVisibleHours(text: string): string {
  const match =
    text.match(/\bhours?\s*(?:showing|showing\s+unverified)?\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\b/i) ||
    text.match(/\bshowing\s+hours?\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\b/i) ||
    text.match(/\b([\d,]+(?:\.\d+)?)\s*hours?\s*(?:showing)?\b/i);
  return match?.[1] || "";
}

function getSelectionValue(rec: any, key: "condition" | "completeness" | "legal"): string {
  const selections = rec?.condition_report_selections || {};
  const value = String(selections?.[key] ?? "").trim();
  return /^n\/?a$/i.test(value) ? "" : value;
}

function isDamageField(field: string): boolean {
  const key = normalizeSpecKey(field);
  return key === "damage" || key === "damages" || key === "damageanalysis";
}

function getAugmentedStructuredSpecs(
  rec: any,
  conditionText: string,
  category: string
): Record<string, any> {
  // Explicit structured values win. Text-derived values only fill gaps so
  // regeneration cannot overwrite a user's reviewed preview edits.
  const structuredSpecs = getStructuredSpecs(rec);
  const specs: Record<string, any> = { ...structuredSpecs };
  const categorySpec = resolveCategorySpec(category, rec, conditionText);
  const fields = categorySpec?.fields?.length ? categorySpec.fields : masterSpecHeaders;
  const visibleText = [
    rec?.title,
    rec?.description,
    rec?.details,
    rec?.serial_number,
    rec?.sn_vin,
    rec?.serial_no_or_label,
    conditionText,
  ]
    .filter(Boolean)
    .join(", ");

  const serial = deriveSerialFromRecord(rec);
  const conditionSelection = getSelectionValue(rec, "condition");
  const completenessSelection = getSelectionValue(rec, "completeness");
  const legalSelection = getSelectionValue(rec, "legal");
  setAugmentedSpec(specs, fields, [/^serialnumber$/, /\bvin\b/, /^sn$/], serial);
  setAugmentedSpec(specs, fields, [/runningcondition/, /workingcondition/], conditionSelection);
  setAugmentedSpec(specs, fields, [/haskey/, /keyspresent/, /^keys$/], /has keys?/i.test(completenessSelection) ? "Yes" : "");
  setAugmentedSpec(specs, fields, [/missingparts/], /missing parts/i.test(completenessSelection) ? "Yes" : "");
  setAugmentedSpec(specs, fields, [/incompleteunit/], /incomplete unit/i.test(completenessSelection) ? "Yes" : "");
  setAugmentedSpec(specs, fields, [/ownershiptype/, /titlestatus/, /registrationhistory/], legalSelection);
  setAugmentedSpec(specs, fields, [/trimlevel/, /^trim$/], getDecodedVinValue(rec, "trim"));
  setAugmentedSpec(specs, fields, [/bodyclass/, /^body$/], getDecodedVinValue(rec, "bodyClass"));
  setAugmentedSpec(specs, fields, [/drivetype/, /^drive$/], getDecodedVinValue(rec, "driveType") || parseVisibleDrive(visibleText));
  setAugmentedSpec(specs, fields, [/enginecylinders/], getDecodedVinValue(rec, "engineCylinders"));
  setAugmentedSpec(specs, fields, [/enginedisplacement/, /^displacement$/], getDecodedVinValue(rec, "displacementL") ? `${getDecodedVinValue(rec, "displacementL")}L` : parseVisibleEngineDisplacement(visibleText));
  setAugmentedSpec(specs, fields, [/^engine$/, /^enginemodel$/, /^enginehp$/, /^enginehp/], parseVisibleEngine(visibleText));
  setAugmentedSpec(specs, fields, [/fueltype/, /^fuel$/], getDecodedVinValue(rec, "fuelType") || parseVisibleFuel(visibleText));
  setAugmentedSpec(specs, fields, [/turbocharged/], /\bturbo(?:charged)?\b/i.test(visibleText) ? "Yes" : "");
  setAugmentedSpec(specs, fields, [/transmissiontype/, /^transmission$/], getDecodedVinValue(rec, "transmissionStyle") || parseVisibleTransmission(visibleText));
  setAugmentedSpec(specs, fields, [/transmissionspeeds/], getDecodedVinValue(rec, "transmissionSpeeds"));
  setAugmentedSpec(specs, fields, [/showingmileage/, /mileage/, /odometer/], parseVisibleMileage(visibleText));
  setAugmentedSpec(specs, fields, [/showinghours/, /hours/], parseVisibleHours(visibleText));
  setAugmentedSpec(specs, fields, [/^colour$/, /^color$/, /exteriorcolour/, /exteriorcolor/], parseVisibleColour(visibleText));
  setAugmentedSpec(specs, fields, [/doorcount/, /^doors$/], parseVisibleDoorCount(visibleText));
  setAugmentedSpec(specs, fields, [/vehicletype/], getDecodedVinValue(rec, "vehicleType"));

  return specs;
}

function canonicalCategoryName(value: any): string {
  const rawCategory = String(value ?? "").trim();
  return categoryNameByNormalizedName.get(normalizeSpecKey(rawCategory)) || rawCategory;
}

function inferCategoryFromRecord(rec: any, conditionText: string): string {
  const explicit = getFirstText(
    rec?.categories,
    rec?.category,
    rec?.child_category,
    rec?.asset_category
  );
  if (explicit) return canonicalCategoryName(explicit);

  const textKey = normalizeSpecKey(
    [rec?.title, rec?.description, rec?.details, conditionText]
      .filter(Boolean)
      .join(" ")
  );
  const categoryFromText = [...allowedCategories]
    .sort((left, right) => right.length - left.length)
    .find((category) => {
      const key = normalizeSpecKey(category);
      return key.length > 5 && textKey.includes(key);
    });
  if (categoryFromText) return categoryFromText;

  const specKeys = Object.keys(getStructuredSpecs(rec)).map(normalizeSpecKey);
  if (specKeys.length > 0) {
    let bestCategory = "";
    let bestScore = 0;
    for (const spec of assetCategorySpecs) {
      const fieldKeys = new Set(spec.fields.map(normalizeSpecKey));
      const score = specKeys.reduce(
        (sum, key) => sum + (fieldKeys.has(key) ? 1 : 0),
        0
      );
      if (score > bestScore) {
        bestScore = score;
        bestCategory = spec.childCategory;
      }
    }
    if (bestScore > 0) return bestCategory;
  }

  return "";
}

function resolveCategorySpec(category: any, rec?: any, conditionText = "") {
  const rawCategory = canonicalCategoryName(
    category || inferCategoryFromRecord(rec, conditionText)
  );
  if (!rawCategory) return null;
  return categorySpecByName.get(normalizeSpecKey(rawCategory)) || null;
}

function buildSpecCells(rec: any, conditionText: string, category: string): string[] {
  const structuredSpecs = getAugmentedStructuredSpecs(rec, conditionText, category);
  const spec = resolveCategorySpec(category, rec, conditionText);
  if (!spec) {
    return masterSpecHeaders.map((header) =>
      getObjectValueByHeader(structuredSpecs, header)
    );
  }

  const applicableFields = new Set(spec.fields.map(normalizeSpecKey));

  return masterSpecHeaders.map((header) => {
    if (!applicableFields.has(normalizeSpecKey(header))) return "";
    return (
      getObjectValueByHeader(structuredSpecs, header) ||
      parseSpecValueFromText(conditionText, header)
    );
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const value = Number(code);
      return Number.isFinite(value) ? String.fromCharCode(value) : "";
    });
}

function stripConditionReportHtml(value: unknown): string {
  const decoded = decodeHtmlEntities(String(value ?? ""));
  return decoded
    .replace(/<\s*br\s*\/?\s*>/gi, " ")
    .replace(/<\s*\/\s*(?:p|div|li|ul|ol)\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeConditionReportTitleCase(value: string): string {
  const protectedTokens: string[] = [];
  const protectedValue = value.replace(
    /(^|[^A-Za-z0-9*])((?=[A-Za-z0-9*]{6,})(?=[A-Za-z0-9*]*\d)(?=[A-Za-z0-9*]*[A-Za-z])[A-Za-z0-9*]+)(?=$|[^A-Za-z0-9*])/g,
    (_match, prefix, token) => {
      const index = protectedTokens.push(String(token).toUpperCase()) - 1;
      return `${prefix}__CRTOKEN${index}__`;
    }
  );
  const titled = toTitleCaseWords(protectedValue)
    .replace(/\bKm\b/g, "km")
    .replace(/\bKms\b/g, "km")
    .replace(/\bKg\b/g, "kg")
    .replace(/\bKgs\b/g, "kg")
    .replace(/\bMm\b/g, "mm")
    .replace(/\bMm2\b/g, "mm2")
    .replace(/\bLbs\b/g, "lbs")
    .replace(/\bLb\b/g, "lb")
    .replace(/\bCc\b/g, "cc")
    .replace(/\bL\b(?=\s*(?:Turbo|Gas|Diesel|Engine|I[- ]?\d|\(|$))/g, "L")
    .replace(/\bVin\b/g, "VIN")
    .replace(/\bSn\b/g, "SN")
    .replace(/\bId\b/g, "ID")
    .replace(/\bGvwr\b/g, "GVWR")
    .replace(/\bFwd\b/g, "FWD")
    .replace(/\bRwd\b/g, "RWD")
    .replace(/\bAwd\b/g, "AWD")
    .replace(/\bUsb\b/g, "USB")
    .replace(/\bAbs\b/g, "ABS")
    .replace(/\bSuv\b/g, "SUV")
    .replace(/\bPto\b/g, "PTO")
    .replace(/\bGps\b/g, "GPS");
  return titled
    .replace(/__Crtoken(\d+)__/g, (_match, index) => protectedTokens[Number(index)] || "")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function formatConditionReportFieldName(field: unknown): string {
  const clean = stripConditionReportHtml(field)
    .replace(/\s*:\s*$/, "")
    .trim();
  return normalizeConditionReportTitleCase(clean);
}

function formatConditionReportSpecValue(field: string, value: unknown): string {
  const withoutSerialPrefix = stripRedundantSerialLabel(field, stripConditionReportHtml(value));
  const visibleValue = normalizeVisiblePresenceValue(withoutSerialPrefix);
  if (visibleValue) return visibleValue;
  return normalizeConditionReportTitleCase(withoutSerialPrefix);
}

function formatConditionReportDamageLine(value: unknown): string {
  return normalizeConditionReportTitleCase(
    stripConditionReportHtml(value)
      .replace(/^(?:damage\s*analysis|damages?)\s*[:\-]\s*/i, "")
      .trim()
  );
}

function buildCategorySpecificationPairs(
  rec: any,
  conditionText: string,
  category: string
): Array<{ field: string; value: string }> {
  // The registry order is presentation order. Keeping it deterministic makes
  // condition-report HTML stable for both reviewers and auction imports.
  const structuredSpecs = getAugmentedStructuredSpecs(rec, conditionText, category);
  const spec = resolveCategorySpec(category, rec, conditionText);
  const pairs: Array<{ field: string; value: string }> = [];
  const seen = new Set<string>();

  if (!spec) {
    for (const field of masterSpecHeaders) {
      if (isDamageField(field)) continue;
      const value = getObjectValueByHeader(structuredSpecs, field);
      if (!value) continue;
      seen.add(normalizeSpecKey(field));
      pairs.push({ field, value });
    }
    for (const [field, rawValue] of Object.entries(structuredSpecs)) {
      const key = normalizeSpecKey(field);
      const value = String(rawValue ?? "").trim();
      if (!field || !isUsefulSpecValue(value) || seen.has(key) || isDamageField(field)) continue;
      seen.add(key);
      pairs.push({ field, value });
    }
    return pairs;
  }

  for (const field of spec.fields) {
    if (isDamageField(field)) continue;
    const value =
      getObjectValueByHeader(structuredSpecs, field) ||
      parseSpecValueFromText(conditionText, field);
    const cleanValue = String(value || "").trim();
    const key = normalizeSpecKey(field);
    if (!isUsefulSpecValue(cleanValue) || seen.has(key)) continue;
    seen.add(key);
    pairs.push({ field, value: cleanValue });
  }

  return pairs;
}

function isStandaloneSpecValue(field: string, value: string): boolean {
  const normalizedField = normalizeSpecKey(field);
  const normalizedValue = normalizeSpecKey(value);
  return (
    normalizedValue === "yes" ||
    normalizedValue === "true" ||
    normalizedValue === "y" ||
    normalizedValue === "present" ||
    normalizedValue === "included" ||
    normalizedValue === normalizedField
  );
}

function buildOtherSpecificationsHtml(rec: any, conditionText: string, category: string): string {
  const labelCellStyle = "border:1px solid #d1d5db;padding:4px 6px;vertical-align:top;width:34%;background:#f8fafc;";
  const valueCellStyle = "border:1px solid #d1d5db;padding:4px 6px;vertical-align:top;";
  const rows = buildAuctioneerSpecRows(rec, {
    conditionText,
    category,
    includeMissing: false,
  })
    .filter((row) => !!stripConditionReportHtml(row.value) && shouldDisplayAuctioneerSpecRow(row))
    .map((row) => {
      const field = formatConditionReportFieldName(row.field);
      const value = formatConditionReportSpecValue(row.field, row.value || AUCTIONEER_NOT_FOUND);
      if (!field || !value) return "";
      return `<tr><td style="${labelCellStyle}"><b>${escapeHtml(field)}</b></td><td style="${valueCellStyle}">${escapeHtml(value)}</td></tr>`;
    })
    .filter(Boolean);

  if (rows.length === 0) return "";
  return `<table style="width:100%;border-collapse:collapse;border:1px solid #d1d5db;">${rows.join("")}</table>`;
}

function buildDamageAnalysisHtml(rec: any, reportData: any, lotNumber?: unknown): string {
  if (
    reportData?.include_damage_analysis === false ||
    String(reportData?.include_damage_analysis ?? "").trim().toLowerCase() === "false" ||
    !isLotDamageAnalysisEligible(lotNumber ?? rec?.lot_number)
  ) {
    return "";
  }
  const rawText = sanitizeDamageAnalysisText(rec?.damage_analysis);
  if (!rawText || isBoilerplateAuctionText(rawText)) return "";
  const lines = formatDamageAnalysisLines(rawText).filter((line) => !isBoilerplateAuctionText(line));
  if (lines.length === 0) return "";
  const cleanLines = lines
    .map(formatConditionReportDamageLine)
    .filter(Boolean);
  if (cleanLines.length === 0) return "";
  return `<hr><p><b>${escapeHtml(DAMAGE_ANALYSIS_LABEL)}:</b></p>${cleanLines
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("")}`;
}

function stripLeadingListMarker(value: string): string {
  return value.replace(/^\s*\d+\.\s*/, "").trim();
}

function deriveTitle(rec: any, conditionText: string): string {
  const explicitTitle = getFirstText(
    rec?.title,
    rec?.asset_title,
    rec?.lot_title,
    rec?.name
  );
  if (explicitTitle) return toTitleCaseWords(explicitTitle);

  const firstConditionSegment = splitConditionSegments(conditionText)[0] || "";
  const fallbackTitle = stripLeadingListMarker(firstConditionSegment)
    .split(",")[0]
    ?.trim();
  return fallbackTitle ? toTitleCaseWords(fallbackTitle) : "";
}

function deriveEstimatedValue(rec: any): string {
  return getFirstText(
    rec?.estimated_value,
    rec?.fmv,
    rec?.fair_market_value,
    rec?.asset_insight,
    rec?.value
  );
}

function deriveCategory(rec: any, conditionText: string): string {
  return inferCategoryFromRecord(rec, conditionText);
}

/**
 * Flattens supported report groupings into the fixed auction-import workbook.
 * The returned Buffer is the complete XLSX payload expected by HTTP and worker
 * callers; no caller-side post-processing should be required.
 */
export async function generateAssetXlsxFromReport(
  reportData: any,
  options: AssetXlsxGenerationOptions = {}
): Promise<Buffer> {
  const grouping: string = String(reportData?.grouping_mode || "single_lot");
  const lots: any[] = normalizeLotsForBusinessRules(
    Array.isArray(reportData?.lots) ? reportData.lots : [],
    {
      preserveDescription: true,
      defaultLocation: reportData?.location || reportData?.inspection_location,
      defaultLatitude: reportData?.latitude,
      defaultLongitude: reportData?.longitude,
      includeDamageAnalysis:
        reportData?.include_damage_analysis !== false &&
        String(reportData?.include_damage_analysis ?? "").trim().toLowerCase() !== "false",
    }
  );
  const defaultContractNo: string = String(
    reportData?.contract_no || reportData?.contract_number || ""
  );
  const includeScheduleAColumn = options.includeScheduleAColumn !== false;
  const headers = ASSET_XLSX_HEADERS.filter(
    (header) => includeScheduleAColumn || header !== "Schedule A"
  );
  // Resolve columns from their contract names rather than scattered numeric
  // offsets. This protects formulas and validations if internals are refactored.
  const columnNumberByHeader = new Map<AssetXlsxHeader, number>(
    headers.map((header, index) => [header, index + 1])
  );
  const getColumnNumber = (header: AssetXlsxHeader): number => {
    const columnNumber = columnNumberByHeader.get(header);
    if (!columnNumber) throw new Error(`Missing asset Excel column: ${header}`);
    return columnNumber;
  };
  let rows: any[][] = [];

  // Helper to derive serial/VIN when absent
  const deriveSerial = (rec: any): string => {
    return deriveSerialFromRecord(rec);
  };

  // Fixed dropdown lists
  const CONDITION_LIST = [
    "Unverified Working Condition",
    "Untested",
    "Unused",
  ];
  const SHOW_ON_WEBSITE_LIST = [0, 1];
  const LOCATION_LIST = [...AUCTION_LOCATION_LIST];
  const LOCATION_COORDINATES = AUCTION_LOCATION_COORDINATES;

  // Categories: use exact child category casing from AI/spec registry.

  const normalizeCondition = (v: any): string => {
    try {
      const fallback = CONDITION_LIST[0];
      if (v === undefined || v === null) return fallback;
      const s = String(v).trim();
      if (!s) return fallback;
      const sl = s.toLowerCase();
      // exact match ignoring case
      const exact = CONDITION_LIST.find((c) => c.toLowerCase() === sl);
      if (exact) return exact;
      if (sl.includes("unused") || sl.includes("new")) return "Unused";
      if (sl.includes("untested")) return "Untested";
      return fallback;
    } catch {
      return CONDITION_LIST[0];
    }
  };

  const toShowOnWebsiteCell = (v: any) => {
    if (v === undefined || v === null || v === "") return 1;
    if (typeof v === "string") {
      return /^(false|0|no|off)$/i.test(v.trim()) ? 0 : 1;
    }
    return v ? 1 : 0;
  };
  const toNumCell = (v: any) => {
    if (v === undefined || v === null) return "";
    const normalized = typeof v === "string" ? v.trim() : v;
    if (normalized === "") return "";
    const n = Number(normalized);
    return Number.isFinite(n) ? n : "";
  };
  const toStrCell = (v: any) => (v === undefined || v === null ? "" : String(v));
  const toSerialCell = (rec: any) => {
    const serial = stripRedundantSerialLabel("Serial Number", deriveSerial(rec)).trim();
    return isMissingOrNegativeCellValue(serial) ? "" : toStrCell(serial);
  };
  const formatClosingTimeCell = (timeValue: any, periodValue?: any) => {
    const rawTime = toStrCell(timeValue).trim();
    if (!rawTime) return "";
    const rawPeriod = toStrCell(periodValue).trim().toUpperCase();
    const embeddedPeriod = rawTime.match(/\b(AM|PM)\b/i)?.[1]?.toUpperCase();
    let period = rawPeriod === "AM" || rawPeriod === "PM"
      ? rawPeriod
      : embeddedPeriod === "AM" || embeddedPeriod === "PM"
        ? embeddedPeriod
        : "";
    const timeText = rawTime.replace(/\b(AM|PM)\b/gi, "").trim();
    const match = timeText.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
    if (!match) return rawTime;

    const originalHour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    if (!Number.isInteger(originalHour) || !Number.isInteger(minute) || originalHour < 0 || originalHour > 23 || minute < 0 || minute > 59) {
      return rawTime;
    }

    let hour = originalHour;
    if (hour === 0) {
      hour = 12;
      period = period || "AM";
    } else if (hour > 12) {
      hour -= 12;
      period = "PM";
    }

    return `${hour}:${String(minute).padStart(2, "0")}${period ? ` ${period}` : ""}`;
  };
  const formatCloseDateCell = (v: any, timeValue?: any, periodValue?: any) => {
    const raw = toStrCell(v).trim();
    const time = formatClosingTimeCell(timeValue, periodValue);
    if (!raw) return time;
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return `${Number(iso[2])}/${Number(iso[3])}/${iso[1]}${time ? ` ${time}` : ""}`;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return `${raw}${time ? ` ${time}` : ""}`;
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}${time ? ` ${time}` : ""}`;
  };
  const toTitleCell = (v: any) => {
    const s = toStrCell(v);
    return s ? toTitleCaseWords(s) : s;
  };
  const mergeItemRow = (lot: any, item: any) => {
    // The lot is the inheritance boundary and the item is the override. Merge
    // specs field-by-field because a shallow object spread would erase useful
    // lot metadata when an item carries an empty or negative placeholder.
    const mergedSpecs = item?.condition_report_specs_reviewed === true ? {} : { ...collectAuctioneerSpecRecord(lot) };
    const itemSpecs = collectAuctioneerSpecRecord(item);
    for (const [field, value] of Object.entries(itemSpecs)) {
      const key = normalizeSpecKey(field);
      const existingKey = Object.keys(mergedSpecs).find(
        (candidate) => normalizeSpecKey(candidate) === key
      );
      const existingValue = existingKey ? mergedSpecs[existingKey] : undefined;
      if (isUsefulSpecValue(value) || !isUsefulSpecValue(existingValue)) {
        mergedSpecs[existingKey || field] = value;
      }
    }
    const merged = {
      ...lot,
      ...item,
      condition_report_specs: mergedSpecs,
      ...reviewedAuctioneerItemSpecState(item),
    };

    // A nested item may not carry the preview-edited auction description. Avoid
    // letting an undefined item field erase the saved lot description used by Excel.
    if (
      (!hasOwnField(item, "description") ||
        item?.description === undefined ||
        item?.description === null) &&
      hasOwnField(lot, "description")
    ) {
      merged.description = lot.description;
    }

    if (
      (!hasOwnField(item, "title") ||
        item?.title === undefined ||
        item?.title === null) &&
      hasOwnField(lot, "title")
    ) {
      merged.title = lot.title;
    }

    if (
      (!hasOwnField(item, "video_urls") || item.video_urls === undefined) &&
      hasOwnField(lot, "video_urls")
    ) {
      merged.video_urls = lot.video_urls;
    }

    // The row's Description cell names this item: its own Title, then its own
    // legacy Description, and only then the parent lot's text. The inherited description
    // above still feeds the Condition Report column.
    merged.excel_item_description = getFirstText(
      hasOwnField(item, "title") ? item.title : "",
      hasOwnField(item, "description") ? item.description : "",
      lot?.title,
      lot?.description
    );

    return merged;
  };
  const mapExcelRow = (rawRec: any, fallbackLotNumber: number): any[] => {
    // Build by header name, then project through `headers`. That final projection
    // guarantees every row retains the external column-order contract.
    const rec = normalizeAuctioneerLotSpecs(rawRec);
    const rawLotNumber = toStrCell(rec?.lot_number).trim();
    const lotNumber = rawLotNumber || String(fallbackLotNumber);
    const conditionReportDetails = buildConditionReportDetails(rec, lotNumber);
    const descriptionCell = buildAuctionDescription(rec);
    const category = deriveCategory(rec, conditionReportDetails);
    const auctionControls = getCrDisclaimersForLot(reportData, rec, fallbackLotNumber - 1);
    const descriptionWithAuctionControls = auctionControls.unreserved
      ? `${descriptionCell}${UNRESERVED_DESCRIPTION_HTML}`
      : descriptionCell;
    const rowByHeader: Record<AssetXlsxHeader, any> = {
      "Lot #": lotNumber,
      Description: descriptionWithAuctionControls,
      "Serial Number": toSerialCell(rec),
      Categories: toStrCell(category),
      "Bid Increment": toNumCell(
        auctionControls.bidIncrement ?? rec?.bid_increment ?? rec?.bidIncrement
      ),
      "Opening Bid": toNumCell(
        auctionControls.openingBid ?? rec?.opening_bid ?? rec?.openingBid
      ),
      "Contract #": toStrCell(defaultContractNo),
      // Auction imports always start as one item and never force a must-take.
      Quantity: 1,
      "Must Take": null,
      "Show On Website": toShowOnWebsiteCell(rec?.show_on_website),
      "Close Date": formatCloseDateCell(
        auctionControls.closingDate || rec?.close_date,
        auctionControls.closingTime,
        auctionControls.closingTimePeriod
      ),
      Location: toStrCell(rec?.location || ""),
      Latitude: toNumCell(rec?.latitude),
      Longitude: toNumCell(rec?.longitude),
      "Item Condition": toStrCell(normalizeCondition(rec?.item_condition)),
      "Lotted By": toStrCell(rec?.lotted_by || reportData?.inspector_name || ""),
      "Condition Report": `${buildOtherSpecificationsHtml(rec, conditionReportDetails, category)}${buildDamageAnalysisHtml(rec, reportData, lotNumber)}${buildCrDisclaimersHtmlForLot(reportData, rec, fallbackLotNumber - 1)}`,
      "Schedule A": toStrCell(
        reportData?.schedule_a_pdf_url ||
          reportData?.preview_files?.schedule_a_pdf ||
          reportData?.files?.schedule_a_pdf ||
          ""
      ),
    };

    return headers.map((header) => rowByHeader[header]);
  };

  // Preserve source lot/item order: lot numbers, review screens, and external
  // auction imports all use row position as a stable human-visible sequence.
  for (const lot of lots) {
    const items: any[] = Array.isArray(lot?.items) ? lot.items : [];
    if (items.length > 0) {
      for (const it of items) rows.push(mapExcelRow(mergeItemRow(lot, it), rows.length + 1));
    } else {
      rows.push(mapExcelRow(lot, rows.length + 1));
    }
  }

  // Ensure every row has a Lot #; fill sequentially in current order
  try {
    let seq = 1;
    for (const r of rows) {
      const current = r?.[0];
      if (current === undefined || current === null || String(current).trim() === "") {
        r[0] = String(seq);
      }
      seq += 1;
    }
  } catch {}

  const workbook = new ExcelJS.Workbook();
  const ws = addWorksheetFromRows(workbook, "Sheet1", [headers, ...rows]);
  // Widths are bounded for arbitrary AI/user text, then contract-critical text
  // columns receive known usable widths for Excel and LibreOffice rendering.
  const widths = getWorksheetColumnWidthsFromRows([headers, ...rows], 10, 60, 4);
  const setColumnWidth = (header: AssetXlsxHeader, width: number) => {
    widths[getColumnNumber(header) - 1] = width;
  };
  // Display width only: keep the complete cell value and wrap it below.
  setColumnWidth("Description", 60);
  setColumnWidth("Serial Number", 22);
  setColumnWidth("Categories", 50);
  setColumnWidth("Location", 50);
  setColumnWidth("Item Condition", 28);
  setColumnWidth("Lotted By", 16);
  setColumnWidth("Condition Report", 64);
  if (includeScheduleAColumn) setColumnWidth("Schedule A", 64);
  setWorksheetColumnWidths(ws, widths);
  ws.views = [{ state: "frozen", ySplit: 1, topLeftCell: "A2" }];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: "top", wrapText: true };
  ws.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });
  const latitudeColumn = getColumnNumber("Latitude");
  const longitudeColumn = getColumnNumber("Longitude");
  const locationColumnLetter = ws.getColumn(getColumnNumber("Location")).letter;
  const closeDateColumn = getColumnNumber("Close Date");
  // Browser-provided coordinates remain authoritative. Formulas only backfill
  // blanks from the support sheet and intentionally fail to an empty cell.
  for (let rowNumber = 2; rowNumber <= rows.length + 1; rowNumber += 1) {
    const latitudeCell = ws.getCell(rowNumber, latitudeColumn);
    const longitudeCell = ws.getCell(rowNumber, longitudeColumn);
    if (latitudeCell.value === "" || latitudeCell.value === null || latitudeCell.value === undefined) {
      latitudeCell.value = {
        formula: `IFNA(VLOOKUP(${locationColumnLetter}${rowNumber},Menis!$I$2:$J$10,2,FALSE),"")`,
      } as any;
    }
    if (longitudeCell.value === "" || longitudeCell.value === null || longitudeCell.value === undefined) {
      longitudeCell.value = {
        formula: `IFNA(VLOOKUP(${locationColumnLetter}${rowNumber},Menis!$I$2:$K$10,3,FALSE),"")`,
      } as any;
    }
    ws.getCell(rowNumber, closeDateColumn).dataValidation = {
      type: "any",
      showInputMessage: true,
      showErrorMessage: true,
      prompt: "MM/DD/YYYY HH:MM (AM/PM)",
    } as any;
  }

  // `Menis` is a machine-facing support sheet. Its sparse column positions and
  // category start row are referenced by formulas/validations below, so blank
  // columns and offsets are intentional compatibility boundaries.
  const categoryStartRow = 16;
  const menisRowCount = Math.max(
    categoryStartRow + allowedCategories.length - 1,
    LOCATION_LIST.length + 1,
    CONDITION_LIST.length + 1,
    SHOW_ON_WEBSITE_LIST.length + 1
  );
  const menisRows = Array.from({ length: menisRowCount }, (_, index) => {
    const rowNumber = index + 1;
    const location = LOCATION_LIST[rowNumber - 2] || "";
    const coords = location ? LOCATION_COORDINATES[location] : undefined;
    return [
      rowNumber >= categoryStartRow
          ? allowedCategories[rowNumber - categoryStartRow] || null
          : null,
      null,
      null,
      rowNumber >= 2 ? CONDITION_LIST[rowNumber - 2] || null : null,
      null,
      null,
      null,
      null,
      location || null,
      coords?.latitude ?? null,
      coords?.longitude ?? null,
      null,
      null,
      null,
      rowNumber >= 2 ? SHOW_ON_WEBSITE_LIST[rowNumber - 2] ?? null : null,
    ];
  });
  const menisWs = addWorksheetFromRows(workbook, "Menis", menisRows);
  setWorksheetColumnWidths(menisWs, [50, 10, 10, 32, 10, 10, 10, 10, 50, 12, 12, 20, 10, 10, 12]);

  const instructionsWs = addWorksheetFromRows(workbook, "Instructions", [
    ["Cells that are drop down menu:"],
    [],
    ["Categories", "", "Show On Website", "", "Latitude / Longitude", "", "Item Condition"],
    [
      "A list of common categories",
      "",
      "0: Do Not Show/1: Show",
      "",
      "Browser location is used when available",
      "",
      "A list of commonly used item conditions",
    ],
    ["", "", "", "", "Coordinates are written from browser location"],
    [],
    ["SPECIAL NOTES"],
    [],
    ["1. Browser-provided Latitude and Longitude are written directly when available"],
    ["2. You will still need to manually add in the coding if it is an UNRESERVED lot"],
  ]);
  setWorksheetColumnWidths(instructionsWs, [38, 10, 22, 10, 34, 10, 34]);

  // Apply validations beyond current data so operators can append rows without
  // losing the controlled vocabularies supplied by the workbook.
  const validationRows = Math.max(rows.length + 200, 1000);
  applyListValidationToColumn(
    ws,
    getColumnNumber("Item Condition"),
    "'Menis'!$D$2:$D$4",
    validationRows
  );
  applyListValidationToColumn(
    ws,
    getColumnNumber("Categories"),
    `'Menis'!$A$${categoryStartRow}:$A$${categoryStartRow + allowedCategories.length - 1}`,
    validationRows
  );
  applyListValidationToColumn(
    ws,
    getColumnNumber("Show On Website"),
    "'Menis'!$O$2:$O$3",
    validationRows
  );

  return workbookToBuffer(workbook);
}

/**
 * Lot Listing imports use the shared auction workbook format, but Schedule A
 * is an Asset-only import column.
 */
export function generateLotListingXlsxFromReport(
  reportData: any
): Promise<Buffer> {
  return generateAssetXlsxFromReport(reportData, { includeScheduleAColumn: false });
}
