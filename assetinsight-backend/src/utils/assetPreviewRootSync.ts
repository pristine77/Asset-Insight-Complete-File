import { calculateAssetLotsTotalValue } from "./assetTotalValue.js";
import { resolvePhotoWatermark } from "./photoWatermarkPolicy.js";

const STRING_FIELDS = [
  "contract_no",
  "client_name",
  "prepared_for",
  "appraisal_purpose",
  "owner_name",
  "appraiser",
  "appraisal_company",
  "industry",
  "language",
  "currency",
  "damage_analysis",
] as const;

const BOOLEAN_FIELDS = [
  "include_damage_analysis",
  "bank_photos_enabled",
  "watermark_images",
  "include_valuation_table",
] as const;

const DATE_FIELDS = ["effective_date", "inspection_date"] as const;

function parseMoney(value: unknown): number | undefined {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Asset preview data is editable, while several legacy readers still use root
 * fields. Keep those mirrors synchronized before queueing a job so filenames,
 * emails, list rows, and generated artifacts all use the exact submitted data.
 */
export function syncAssetPreviewDataToRoot(report: any, previewData: any): void {
  if (!report || !previewData || typeof previewData !== "object") return;

  if (
    (report as any).is_merged_report === true ||
    previewData.is_merged_report === true
  ) {
    const totalValue = calculateAssetLotsTotalValue(previewData.lots);
    previewData.total_value = totalValue;
    previewData.total_appraised_value = totalValue;
    if (previewData.valuation_data && typeof previewData.valuation_data === "object") {
      previewData.valuation_data = {
        ...previewData.valuation_data,
        baseFMV: totalValue,
        methods: Array.isArray(previewData.valuation_data.methods)
          ? previewData.valuation_data.methods.map((method: any) => ({
              ...method,
              value: Number.isFinite(Number(method?.percentage))
                ? (totalValue * Number(method.percentage)) / 100
                : method?.value,
            }))
          : previewData.valuation_data.methods,
      };
    }
  }

  for (const field of STRING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(previewData, field)) continue;
    const value = previewData[field];
    report.set?.(field, value == null ? undefined : String(value).trim());
  }

  for (const field of BOOLEAN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(previewData, field)) continue;
    report.set?.(field, field === "watermark_images"
      ? resolvePhotoWatermark(previewData[field], report.watermark_images)
      : previewData[field] === true);
  }

  for (const field of DATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(previewData, field)) continue;
    const value = previewData[field];
    const parsed = value ? new Date(value) : undefined;
    report.set?.(
      field,
      parsed && Number.isFinite(parsed.getTime()) ? parsed : undefined
    );
  }

  for (const field of ["total_value", "total_appraised_value"] as const) {
    if (!Object.prototype.hasOwnProperty.call(previewData, field)) continue;
    const value = parseMoney(previewData[field]);
    report.set?.(field, value);
  }

  if (Array.isArray(previewData.lots)) {
    report.set?.("lots", previewData.lots);
    report.markModified?.("lots");
  }
  if (Array.isArray(previewData.valuation_methods)) {
    report.set?.("valuation_methods", previewData.valuation_methods);
  }
  if (previewData.valuation_data && typeof previewData.valuation_data === "object") {
    report.set?.("valuation_data", previewData.valuation_data);
    report.markModified?.("valuation_data");
  }

  // The Asset model pre-validation hook derives contract_key from contract_no.
  // Marking the preview ensures nested edits are persisted by Mongoose as well.
  report.markModified?.("preview_data");
}
