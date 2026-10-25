import { resolvePhotoWatermark } from "./photoWatermarkPolicy.js";
import { getExplicitCoordinates } from "./auctionLocations.js";
import { normalizeReportContractKey } from "./reportContractIdentity.js";
import { normalizeLotListingValuationMethods } from "./lotListingValuationMethods.js";

function clonePlain<T>(value: T): T {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

function previewAmount(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function previewTotal(lots: any[]): number {
  return lots.reduce((sum, lot) => sum + previewAmount(lot?.estimated_value), 0);
}

/**
 * Build the root + preview mutation shared by owner and assigned-approver
 * endpoints. Atomic updates bypass Mongoose document validation hooks, so this
 * explicitly maintains the normalized contract key and coordinate-clearing
 * contract that document saves otherwise provide.
 */
export function buildLotListingPreviewPersistence(
  nextPreviewData: any,
  listing: any
): {
  previewData: any;
  set: Record<string, unknown>;
  unset: Record<string, 1>;
} {
  const valuationMethods = normalizeLotListingValuationMethods(
    nextPreviewData?.valuation_methods,
    normalizeLotListingValuationMethods(listing?.valuation_methods)
  );
  const previewData = {
    ...(nextPreviewData || {}),
    valuation_methods: valuationMethods,
  };
  const lots = Array.isArray(previewData.lots)
    ? clonePlain(previewData.lots)
    : [];
  const set: Record<string, unknown> = {
    preview_data: previewData,
    lots,
    valuation_methods: valuationMethods,
    include_damage_analysis: resolveBoolean(
      previewData.include_damage_analysis,
      listing?.include_damage_analysis !== false
    ),
    bank_photos_enabled: resolveBoolean(
      previewData.bank_photos_enabled,
      listing?.bank_photos_enabled === true
    ),
    watermark_images: resolvePhotoWatermark(
      previewData.watermark_images,
      listing?.watermark_images
    ),
  };
  const unset: Record<string, 1> = {};

  if (typeof previewData.contract_no === "string") {
    set.contract_no = previewData.contract_no;
    const contractKey = normalizeReportContractKey(previewData.contract_no);
    if (contractKey) set.contract_key = contractKey;
    else unset.contract_key = 1;
  }
  if (previewData.sales_date) {
    const salesDate = new Date(previewData.sales_date);
    if (!Number.isNaN(salesDate.getTime())) set.sales_date = salesDate;
  }
  if (typeof previewData.location === "string") {
    set.location = previewData.location;
  }

  const coordinates = getExplicitCoordinates(previewData);
  if (coordinates) {
    set.latitude = coordinates.latitude;
    set.longitude = coordinates.longitude;
  } else {
    unset.latitude = 1;
    unset.longitude = 1;
  }
  if (previewData.currency) {
    set.currency = String(previewData.currency).toUpperCase();
  }

  const explicitTotal = Number(previewData.total_value);
  set.total_value = Number.isFinite(explicitTotal)
    ? explicitTotal
    : previewTotal(lots);

  return { previewData, set, unset };
}
