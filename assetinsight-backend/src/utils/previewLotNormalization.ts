import { allowedCategories } from "./assetCategorySpecs.js";
import {
  collectAuctioneerSpecRecord,
  deriveAuctioneerSerial,
  isAuctioneerSerialField,
  normalizeAuctioneerSpecKey,
} from "./auctioneerSpecRows.js";
import {
  applyAuctionLocationCoordinatesToRecord,
  getExplicitCoordinates,
  getAuctionLocationCoordinates,
  isReadableAuctionLocation,
  OFFSITE_AUCTION_LOCATION,
  resolveAuctionLocation,
} from "./auctionLocations.js";
import {
  enforceLotDamageAnalysisPolicy,
  resolveDamageAnalysisEnabled,
} from "./lotDamagePolicy.js";
import { buildPolicySafeReportDamageAnalysis } from "./assetDamageAnalysis.js";

const categoryByKey = new Map(
  allowedCategories.map((category) => [normalizeAuctioneerSpecKey(category), category])
);

const SHIPPING_CONTAINER_CATEGORY =
  categoryByKey.get("shippingcontainers") ||
  allowedCategories.find((category) => /shipping\s+containers?/i.test(category)) ||
  "Shipping Containers";

function cleanText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function sameCoordinates(
  left: { latitude: number; longitude: number } | undefined,
  right: { latitude: number; longitude: number } | undefined
): boolean {
  return Boolean(
    left &&
      right &&
      left.latitude === right.latitude &&
      left.longitude === right.longitude
  );
}

/**
 * A readable place-name edit cannot inherit coordinates captured for the prior
 * readable place. A genuinely new coordinate tuple is kept, while inherited
 * lots are changed atomically and independently located lots remain untouched.
 */
export function reconcilePreviewLocationEdit<
  T extends Record<string, any>
>(previewData: T, previousPreviewData?: Record<string, any> | null): T {
  if (!previewData || typeof previewData !== "object") return previewData;
  const previousLocation = cleanText(previousPreviewData?.location);
  const nextLocation = cleanText(previewData.location);
  const changedReadableLocation =
    isReadableAuctionLocation(previousLocation) &&
    isReadableAuctionLocation(nextLocation) &&
    previousLocation.toLowerCase() !== nextLocation.toLowerCase();
  if (!changedReadableLocation) return previewData;

  const previousCoordinates = getExplicitCoordinates(previousPreviewData);
  const nextCoordinates = getExplicitCoordinates(previewData);
  const hasFreshRootCoordinates = Boolean(
    nextCoordinates && !sameCoordinates(nextCoordinates, previousCoordinates)
  );
  const next: Record<string, any> = { ...previewData };
  if (!hasFreshRootCoordinates) {
    delete next.latitude;
    delete next.longitude;
  }

  if (Array.isArray(previewData.lots)) {
    next.lots = previewData.lots.map((lot: any) => {
      const lotLocation = cleanText(lot?.location);
      const inheritsPreviousLocation =
        !isReadableAuctionLocation(lotLocation) ||
        lotLocation.toLowerCase() === previousLocation.toLowerCase();
      if (!inheritsPreviousLocation) return lot;

      const lotCoordinates = getExplicitCoordinates(lot);
      const hasConsistentFreshCoordinates = Boolean(
        hasFreshRootCoordinates &&
          sameCoordinates(lotCoordinates, nextCoordinates)
      );
      const nextLot = { ...lot, location: nextLocation };
      if (!hasConsistentFreshCoordinates) {
        delete nextLot.latitude;
        delete nextLot.longitude;
      }
      return nextLot;
    });
  }

  return next as T;
}

function removeConditionSelectionText(value: string): string {
  return value
    .replace(/\bRunning\s+Condition\s*:\s*[^;,.]+[;,.]?\s*/gi, "")
    .replace(/\bCondition\s*:\s*[^;,.]+[;,.]?\s*/gi, "")
    .replace(/\bCompleteness\s*:\s*[^;,.]+[;,.]?\s*/gi, "")
    .replace(/\bLegal\s*:\s*[^;,.]+[;,.]?\s*/gi, "")
    .replace(/\bRunning\s*$/gi, "")
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/^[\s,;.-]+|[\s,;.-]+$/g, "")
    .trim();
}

export function stripLeadingDescriptionMarker(value: unknown): string {
  const withoutMarker = cleanText(value).replace(/^\s*(?:(?:lot)\s*#?\s*)?[a-z]?\d+[a-z]?\s*[\.)\-:]\s+/i, "").trim();
  return removeConditionSelectionText(withoutMarker);
}

/**
 * Longest Description the AI may write for a lot. Title and Description are
 * separate fields: the Title is the short headline (YEAR MAKE MODEL type),
 * the Description a sentence or two on what the item is and what comes with
 * it (owner decision 2026-10-11; previously a 60-character title-style
 * phrase, which made the two fields read the same). Only AI output is cut;
 * preview and export paths pass preserveDescription, so typed text is kept.
 */
export const AUCTION_DESCRIPTION_MAX_LENGTH = 250;

export function truncateAuctionDescription(
  value: unknown,
  maxLength = AUCTION_DESCRIPTION_MAX_LENGTH
): string {
  const text = stripLeadingDescriptionMarker(value);
  if (text.length <= maxLength) return text;

  const hardCut = text.slice(0, maxLength).trim();
  const wordCut = hardCut.replace(/\s+\S*$/, "").trim();
  return wordCut.length >= Math.min(24, maxLength) ? wordCut : hardCut;
}

function isMissingValue(value: unknown): boolean {
  return /^(n\/a|na|none|null|unknown|not visible|not found|tbd)$/i.test(cleanText(value));
}

function isPrimarySerialSpecField(value: unknown): boolean {
  return isAuctioneerSerialField(String(value ?? ""));
}

function hasDeletedPrimarySerial(lot: any): boolean {
  const deletedCollections = [
    lot?.condition_report_specs_deleted,
    lot?.deleted_condition_report_specs,
    lot?.removed_condition_report_specs,
    lot?.hidden_condition_report_specs,
  ];

  return deletedCollections.some((collection) => {
    if (Array.isArray(collection)) {
      return collection.some(isPrimarySerialSpecField);
    }
    if (collection && typeof collection === "object") {
      return Object.entries(collection).some(
        ([field, deleted]) => Boolean(deleted) && isPrimarySerialSpecField(field)
      );
    }
    return false;
  });
}

function removePrimarySerialSpecs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((entry: any) => !isPrimarySerialSpecField(entry?.field));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([field]) => !isPrimarySerialSpecField(field)
    )
  );
}

/**
 * A cleared primary serial is a user decision, not missing generated data.
 * Persist one canonical deletion marker and remove legacy aliases so later
 * save/regeneration passes cannot reconstruct the value.
 */
function clearPrimarySerial(next: any): void {
  next.serial_number = "";
  for (const field of ["serial_no_or_label", "sn_vin", "vin", "sn"]) {
    if (Object.prototype.hasOwnProperty.call(next, field)) next[field] = "";
  }

  next.condition_report_specs = removePrimarySerialSpecs(
    next.condition_report_specs
  );
  if (Array.isArray(next.condition_report_specs_custom_order)) {
    next.condition_report_specs_custom_order =
      next.condition_report_specs_custom_order.filter(
        (field: unknown) => !isPrimarySerialSpecField(field)
      );
  }

  const deleted = Array.isArray(next.condition_report_specs_deleted)
    ? next.condition_report_specs_deleted.filter(
        (field: unknown) => !isPrimarySerialSpecField(field)
      )
    : [];
  next.condition_report_specs_deleted = [...deleted, "Serial Number"];
}

function normalizeCategory(value: unknown): string {
  const text = cleanText(value);
  return categoryByKey.get(normalizeAuctioneerSpecKey(text)) || text;
}

function looksLikeShippingContainer(lot: any): boolean {
  const text = [
    lot?.categories,
    lot?.title,
    lot?.description,
    lot?.details,
    ...(Array.isArray(lot?.tags) ? lot.tags : []),
  ]
    .map(cleanText)
    .filter(Boolean)
    .join(" ");

  return /\b(?:shipping|storage|sea|cargo|freight|c[-\s]?can|seacan)\s+containers?\b/i.test(text) ||
    /\b(?:20|40|45)\s*(?:ft|foot|')\s+(?:shipping|storage|sea|cargo)?\s*containers?\b/i.test(text);
}

function deriveSerialFromSpecsOrText(lot: any): string {
  const direct = deriveAuctioneerSerial(lot);
  if (direct && !isMissingValue(direct)) return direct;

  const specs = collectAuctioneerSpecRecord(lot);
  for (const [field, value] of Object.entries(specs)) {
    const fieldKey = normalizeAuctioneerSpecKey(field);
    if ((fieldKey === "serialnumber" || fieldKey === "vin" || fieldKey === "sn") && !isMissingValue(value)) {
      return cleanText(value);
    }
  }
  return "";
}

function normalizeOneLot(
  lot: any,
  index: number,
  options: {
    defaultLocation?: string;
    defaultLatitude?: unknown;
    defaultLongitude?: unknown;
    includeDamageAnalysis?: boolean;
    honorExplicitSerialClear?: boolean;
    preserveDescription?: boolean;
  } = {}
) {
  if (!lot || typeof lot !== "object") return lot;
  const next = { ...lot };

  // Mongo requires stable lot identity and a usable title. Missing legacy
  // descriptions get a fallback, but reviewed explicit blanks stay blank.
  // Generated lots can omit one of these fields, so normalize them once before
  // every save/regeneration path instead of allowing a large report to fail.
  const fallbackLotNumber = cleanText(next.lot_number || next.lot_id) || String(index + 1);
  const fallbackTitle =
    cleanText(next.title) ||
    cleanText(next.type) ||
    cleanText(next.categories) ||
    `Lot ${fallbackLotNumber}`;
  const rawDescription = String(next.description ?? "").trim();
  const fallbackDescription =
    cleanText(next.description) || cleanText(next.details) || fallbackTitle;
  next.lot_id = cleanText(next.lot_id) || `lot-${index + 1}`;
  next.title = fallbackTitle;
  // Asset and Lot Listing preview/export callers preserve an existing description,
  // including line breaks and text longer than the AI-ingress limit. Other callers
  // retain the established concise normalization contract.
  const preserveExplicitBlank = options.preserveDescription === true &&
    typeof next.description === "string" && rawDescription === "";
  next.description = preserveExplicitBlank
    ? next.description
    : (options.preserveDescription ? rawDescription : "") ||
      truncateAuctionDescription(fallbackDescription) ||
      fallbackTitle;

  const defaultLocation = isReadableAuctionLocation(options.defaultLocation)
    ? cleanText(options.defaultLocation)
    : "";
  const defaultCoordinates = getExplicitCoordinates({
    latitude: options.defaultLatitude,
    longitude: options.defaultLongitude,
  });
  const locationRecord = applyAuctionLocationCoordinatesToRecord(
    next,
    defaultLocation
  );
  const location = cleanText(locationRecord.location);
  const resolvedDefaultLocation = defaultLocation
    ? resolveAuctionLocation(defaultLocation)
    : "";
  const inheritsDefaultLocation =
    !isReadableAuctionLocation(next.location) ||
    (Boolean(resolvedDefaultLocation) &&
      location.toLowerCase() === resolvedDefaultLocation.toLowerCase());
  const coordinates = location === OFFSITE_AUCTION_LOCATION
    ? undefined
    : getExplicitCoordinates(locationRecord) ||
      (inheritsDefaultLocation ? defaultCoordinates : undefined) ||
      getAuctionLocationCoordinates(location);
  delete next.location;
  delete next.latitude;
  delete next.longitude;
  if (location) next.location = location;
  if (coordinates) Object.assign(next, coordinates);

  if (looksLikeShippingContainer(next)) {
    next.categories = SHIPPING_CONTAINER_CATEGORY;
  } else if (cleanText(next.categories)) {
    next.categories = normalizeCategory(next.categories);
  }

  const hasExplicitBlankSerial =
    options.honorExplicitSerialClear === true &&
    Object.prototype.hasOwnProperty.call(next, "serial_number") &&
    typeof next.serial_number === "string" &&
    next.serial_number.trim() === "";
  if (hasDeletedPrimarySerial(next) || hasExplicitBlankSerial) {
    clearPrimarySerial(next);
  } else {
    const serial = deriveSerialFromSpecsOrText(next);
    if (serial && (!cleanText(next.serial_number) || isMissingValue(next.serial_number))) {
      next.serial_number = serial;
    }
  }

  if (!cleanText(next.lot_number) && cleanText(next.lot_id)) {
    next.lot_number = cleanText(next.lot_id);
  } else if (!cleanText(next.lot_number)) {
    next.lot_number = String(index + 1);
  }

  return enforceLotDamageAnalysisPolicy(next, {
    includeDamageAnalysis: options.includeDamageAnalysis,
    fallbackLotNumber: index + 1,
  });
}

export function normalizePreviewLotsForBusinessRules<T extends Record<string, any>>(
  previewData: T,
  options: {
    defaultLocation?: string;
    preserveDescription?: boolean;
    previousPreviewData?: Record<string, any> | null;
  } = {}
): T {
  if (!previewData || typeof previewData !== "object" || !Array.isArray(previewData.lots)) {
    return previewData;
  }
  const reconciledPreviewData = reconcilePreviewLocationEdit(
    previewData,
    options.previousPreviewData
  );
  const defaultLocationCandidate =
    options.defaultLocation ||
    reconciledPreviewData.location ||
    reconciledPreviewData.inspection_location;
  const defaultLocation = isReadableAuctionLocation(defaultLocationCandidate)
    ? cleanText(defaultLocationCandidate)
    : "";
  const withLocation = applyAuctionLocationCoordinatesToRecord(
    {
      ...reconciledPreviewData,
    },
    defaultLocation
  );
  const includeDamageAnalysis = resolveDamageAnalysisEnabled(
    withLocation.include_damage_analysis,
    true
  );
  const lots = withLocation.lots.map((lot: any, index: number) =>
    normalizeOneLot(lot, index, {
      defaultLocation,
      defaultLatitude: withLocation.latitude,
      defaultLongitude: withLocation.longitude,
      includeDamageAnalysis,
      honorExplicitSerialClear: true,
      preserveDescription: options.preserveDescription,
    })
  );
  return {
    ...withLocation,
    lots,
    damage_analysis: buildPolicySafeReportDamageAnalysis(
      lots,
      withLocation.damage_analysis,
      includeDamageAnalysis
    ),
  };
}

export function normalizeLotsForBusinessRules<T extends any[]>(
  lots: T,
  options: {
    defaultLocation?: string;
    defaultLatitude?: unknown;
    defaultLongitude?: unknown;
    includeDamageAnalysis?: boolean;
    honorExplicitSerialClear?: boolean;
    preserveDescription?: boolean;
  } = {}
): T {
  if (!Array.isArray(lots)) return lots;
  return lots.map((lot, index) => normalizeOneLot(lot, index, options)) as T;
}
