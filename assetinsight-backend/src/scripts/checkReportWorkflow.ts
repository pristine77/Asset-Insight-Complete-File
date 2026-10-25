import assert from "node:assert/strict";
import { approvalAutomaticallyReleases, markReportAutoReleased } from "../service/reportReleaseService.js";
import { resolveReportGenerationState } from "../utils/reportFileState.js";
import { requiresAssetApprovalAtThreshold } from "../utils/assetApprovalThreshold.js";
import { calculateAssetLotsTotalValue } from "../utils/assetTotalValue.js";
import { assignSequentialMergedLotNumbers } from "../utils/mergedAssetLotNumbers.js";

const fileSet = { excel: "https://files.example/report.xlsx" };

assert.equal(
  resolveReportGenerationState({ status: "processing", job_status: "processing" }).workflow_stage,
  "preparing_preview"
);
assert.equal(
  resolveReportGenerationState({ status: "preview", job_status: "done" }).workflow_stage,
  "preview_ready"
);
assert.equal(
  resolveReportGenerationState({
    status: "preview",
    job_status: "queued",
    preview_submitted_at: new Date(),
  }).workflow_stage,
  "generating_files"
);
assert.equal(
  resolveReportGenerationState({ status: "pending_approval" }, fileSet).workflow_stage,
  "awaiting_approval"
);
assert.equal(
  resolveReportGenerationState({
    status: "approved",
    release_status: "pending_release",
  }, fileSet).workflow_stage,
  "awaiting_release"
);
assert.equal(
  resolveReportGenerationState({ status: "approved", release_status: "released" }, fileSet)
    .workflow_stage,
  "ready"
);
assert.equal(
  resolveReportGenerationState({ status: "error", job_error: "failed" }).workflow_stage,
  "error"
);

const legacyLotListing: Record<string, unknown> = {
  release_status: "pending_release",
  release_assigned_to: "507f1f77bcf86cd799439011",
  approval_assigned_to: "507f1f77bcf86cd799439012",
};
markReportAutoReleased(legacyLotListing);
assert.equal(legacyLotListing.release_status, "released");
assert.equal(legacyLotListing.release_assigned_to, null);
assert.equal(approvalAutomaticallyReleases("RealEstate"), true);
assert.equal(approvalAutomaticallyReleases("Salvage"), true);
assert.equal(approvalAutomaticallyReleases("Asset"), false);
assert.equal(approvalAutomaticallyReleases("LotListing"), false);

const assetAt = (value: number) => ({
  preview_data: { lots: [{ estimated_value: value }] },
});
assert.equal(requiresAssetApprovalAtThreshold(assetAt(0), 500_000), false);
assert.equal(requiresAssetApprovalAtThreshold(assetAt(500_000), 500_000), false);
assert.equal(requiresAssetApprovalAtThreshold(assetAt(500_001), 500_000), true);

assert.equal(
  calculateAssetLotsTotalValue([
    { estimated_value: "$10,000" },
    {
      // Legacy catalogue lots sometimes stored only the first item at lot level.
      estimated_value: "$5,000",
      items: [{ estimated_value: "$5,000" }, { estimated_value: "$7,500" }],
    },
  ]),
  22_500
);

const sequentialMergedLots = assignSequentialMergedLotNumbers([
  { lot_id: "merge-a-1", lot_number: "10", title: "First source lot" },
  { lot_id: "merge-b-1", lot_number: "10", title: "Second source lot" },
  { lot_id: "merge-b-2", lot_number: "44", title: "Third source lot" },
]);
assert.deepEqual(
  sequentialMergedLots.map((lot) => lot.lot_number),
  ["1", "2", "3"]
);
assert.deepEqual(
  sequentialMergedLots.map((lot) => lot.merge_source_lot_number),
  ["10", "10", "44"]
);

console.log("Report workflow policy checks passed.");
