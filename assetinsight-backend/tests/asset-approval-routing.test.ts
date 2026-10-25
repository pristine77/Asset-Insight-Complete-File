import { describe, expect, it } from "vitest";
import {
  calculateAssetApprovalValue,
  requiresAssetApprovalAtThreshold,
  shouldEnterAssetApprovalQueue,
} from "../src/utils/assetApprovalThreshold.js";

describe("Asset approval routing", () => {
  it("requires both an exceeded threshold and an assigned approver", () => {
    expect(shouldEnterAssetApprovalQueue(true, "approver-id")).toBe(true);
    expect(shouldEnterAssetApprovalQueue(false, "approver-id")).toBe(false);
    expect(shouldEnterAssetApprovalQueue(true, null)).toBe(false);
    expect(shouldEnterAssetApprovalQueue(false, null)).toBe(false);
  });

  it("routes only values strictly above the configured limit", () => {
    const atLimit = { preview_data: { valuation_data: { baseFMV: 500_000 } } };
    const aboveLimit = { preview_data: { valuation_data: { baseFMV: 500_001 } } };

    expect(requiresAssetApprovalAtThreshold(atLimit, 500_000)).toBe(false);
    expect(requiresAssetApprovalAtThreshold(aboveLimit, 500_000)).toBe(true);
  });

  it("uses the combined lot value when a report aggregate is unavailable", () => {
    const report = {
      preview_data: {
        lots: [
          { estimated_value: "CA$16,500" },
          { items: [{ estimated_value: "$2,500" }, { estimated_value: "1,000" }] },
        ],
      },
    };

    expect(calculateAssetApprovalValue(report)).toBe(20_000);
  });
});
