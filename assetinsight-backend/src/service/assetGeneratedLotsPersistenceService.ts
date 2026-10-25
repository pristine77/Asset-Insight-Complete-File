import AssetReport from "../models/asset.model.js";

/**
 * Persists generator-owned lot/enrichment paths without replacing the Mixed
 * preview_data object. Proposal Valuation lives at the sibling
 * preview_data.admin_schedule_sheet path and may be updated concurrently.
 */
export async function persistAssetGeneratedLots(input: {
  reportId: string;
  lots: unknown[];
  analysis?: Record<string, unknown>;
  derivedPreviewData?: Record<string, any>;
  claimFilter?: Record<string, unknown>;
}) {
  const set: Record<string, unknown> = {
    lots: input.lots,
    "preview_data.lots": input.lots,
  };
  if (input.analysis) set.analysis = input.analysis;
  const derived = input.derivedPreviewData;
  for (const field of ["total_value", "total_appraised_value"] as const) {
    if (
      derived &&
      Object.prototype.hasOwnProperty.call(derived, field) &&
      derived[field] !== undefined
    ) {
      set[`preview_data.${field}`] = derived[field];
    }
  }
  const valuationData = derived?.valuation_data;
  if (valuationData && typeof valuationData === "object") {
    for (const field of ["baseFMV", "methods"] as const) {
      if (
        Object.prototype.hasOwnProperty.call(valuationData, field) &&
        valuationData[field] !== undefined
      ) {
        set[`preview_data.valuation_data.${field}`] = valuationData[field];
      }
    }
  }
  const result = await AssetReport.updateOne(
    { _id: input.reportId, ...(input.claimFilter || {}) },
    { $set: set }
  );
  if (input.claimFilter && result.matchedCount !== 1) {
    throw Object.assign(
      new Error(
        `Asset file generation no longer owns report ${input.reportId}`
      ),
      { code: "ASSET_PREVIEW_FILES_OWNERSHIP_LOST", statusCode: 409 }
    );
  }
  return result;
}
