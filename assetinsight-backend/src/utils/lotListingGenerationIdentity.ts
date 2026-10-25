import { createHash } from "node:crypto";

function clonePlain<T>(value: T): T {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();

  return Object.keys(value)
    .sort()
    .reduce<Record<string, any>>((normalized, key) => {
      if (value[key] !== undefined) normalized[key] = stableValue(value[key]);
      return normalized;
    }, {});
}

export function stableLotListingPreviewJson(value: any): string {
  return JSON.stringify(stableValue(clonePlain(value ?? {})));
}

export function lotListingPreviewFingerprint(value: any): string {
  return createHash("sha256")
    .update(stableLotListingPreviewJson(value))
    .digest("hex");
}

export function matchesLotListingGenerationSnapshot(
  listing: any,
  previewData: any
): boolean {
  const savedFingerprint = String(
    listing?.generation_progress?.previewFingerprint || ""
  ).trim();
  if (savedFingerprint) {
    return savedFingerprint === lotListingPreviewFingerprint(previewData);
  }
  return (
    stableLotListingPreviewJson(listing?.preview_data) ===
    stableLotListingPreviewJson(previewData)
  );
}
