import type { Model } from "mongoose";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";

type LegacyClaimCleanupResult = {
  claimsRemoved: number;
  bypassFlagsRemoved: number;
};

async function removeModelClaims(
  Model: Model<any>,
): Promise<LegacyClaimCleanupResult> {
  const [claims, bypassFlags] = await Promise.all([
    Model.updateMany(
      { submission_contract_claim: { $exists: true } },
      { $unset: { submission_contract_claim: 1 } },
    ),
    Model.updateMany(
      { submission_contract_claim_bypassed: { $exists: true } },
      { $unset: { submission_contract_claim_bypassed: 1 } },
    ),
  ]);

  return {
    claimsRemoved: claims.modifiedCount,
    bypassFlagsRemoved: bypassFlags.modifiedCount,
  };
}

/**
 * Remove the retired contract-admission state without touching contract_key.
 * Contract numbers remain normalized for search, grouping, and display, but
 * they are no longer report identities and may be shared by active reports.
 */
export async function removeLegacyReportSubmissionClaims(): Promise<{
  asset: LegacyClaimCleanupResult;
  lotListing: LegacyClaimCleanupResult;
}> {
  const [asset, lotListing] = await Promise.all([
    removeModelClaims(AssetReport),
    removeModelClaims(LotListing),
  ]);
  return { asset, lotListing };
}
