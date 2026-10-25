import {
  DEFAULT_ASSET_AUTO_APPROVAL_THRESHOLD,
  getAssetAutoApprovalThreshold,
} from "../service/systemSettingsService.js";

export const ASSET_AUTO_APPROVAL_THRESHOLD = DEFAULT_ASSET_AUTO_APPROVAL_THRESHOLD;

function parseMoney(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseFloat(
    String(value ?? "")
      .replace(/,/g, "")
      .replace(/[^0-9.-]+/g, "")
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateAssetApprovalValue(report: any): number {
  const previewData = report?.preview_data || {};
  const baseFMV = previewData?.valuation_data?.baseFMV;
  if (Number.isFinite(Number(baseFMV)) && Number(baseFMV) > 0) {
    return Number(baseFMV);
  }

  const lots = Array.isArray(previewData?.lots)
    ? previewData.lots
    : Array.isArray(report?.lots)
      ? report.lots
      : [];

  return lots.reduce((sum: number, lot: any) => {
    const lotValue = parseMoney(lot?.estimated_value);
    const itemValues = Array.isArray(lot?.items)
      ? lot.items.reduce((itemSum: number, item: any) => itemSum + parseMoney(item?.estimated_value), 0)
      : 0;
    return sum + Math.max(lotValue, itemValues);
  }, 0);
}

export function requiresAssetApprovalAtThreshold(
  report: any,
  threshold: number
): boolean {
  const normalizedThreshold = Number.isFinite(threshold) ? Math.max(0, threshold) : 0;
  return calculateAssetApprovalValue(report) > normalizedThreshold;
}

export async function shouldAutoApproveAssetReport(report: any): Promise<boolean> {
  const threshold = await getAssetAutoApprovalThreshold();
  return !requiresAssetApprovalAtThreshold(report, threshold);
}

/**
 * Approval is a value gate, not merely an approver assignment gate. Reports at
 * or below the configured threshold skip approval; only values above it can be
 * routed to the creator's assigned approver.
 */
export async function requiresAssetApproval(report: any): Promise<boolean> {
  return !(await shouldAutoApproveAssetReport(report));
}

/** A report enters manual approval only when both halves of the gate exist. */
export function shouldEnterAssetApprovalQueue(
  thresholdExceeded: boolean,
  assignedApproverId: unknown
): boolean {
  return thresholdExceeded && Boolean(assignedApproverId);
}
