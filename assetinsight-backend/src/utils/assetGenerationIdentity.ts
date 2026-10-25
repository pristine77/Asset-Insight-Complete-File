import { createHash } from "node:crypto";

const GENERATION_INDEPENDENT_PREVIEW_FIELDS = new Set([
  "admin_schedule_sheet",
]);

function stableAssetGenerationValue(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableAssetGenerationValue);
  if (!value || typeof value !== "object") return value;
  if (typeof value.toHexString === "function") return value.toHexString();

  return Object.keys(value)
    .sort()
    .reduce<Record<string, any>>((normalized, key) => {
      if (value[key] !== undefined) {
        normalized[key] = stableAssetGenerationValue(value[key]);
      }
      return normalized;
    }, {});
}

export function stableAssetPreviewJson(value: any): string {
  // PV has its own revision/CAS boundary and is overlaid by the worker. Keeping
  // it out of the review snapshot prevents a field-level PV projection refresh
  // from invalidating an otherwise identical file-generation handoff.
  const previewData =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            ([key]) => !GENERATION_INDEPENDENT_PREVIEW_FIELDS.has(key)
          )
        )
      : value;
  return JSON.stringify(stableAssetGenerationValue(previewData ?? {}));
}

export function assetPreviewFingerprint(value: any): string {
  return createHash("sha256")
    .update(stableAssetPreviewJson(value))
    .digest("hex");
}

export function matchesAssetGenerationSnapshot(
  report: any,
  previewData: any
): boolean {
  const savedFingerprint = String(
    report?.generation_progress?.previewFingerprint || ""
  ).trim();
  if (savedFingerprint) {
    return savedFingerprint === assetPreviewFingerprint(previewData);
  }
  return (
    stableAssetPreviewJson(report?.preview_data) ===
    stableAssetPreviewJson(previewData)
  );
}
