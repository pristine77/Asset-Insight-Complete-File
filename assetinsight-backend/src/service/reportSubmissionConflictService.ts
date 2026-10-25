import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import { normalizeReportContractKey } from "../utils/reportContractIdentity.js";

export type ActiveReportType = "asset" | "lotListing";

export type ActiveReportConflictInput = {
  reportType: ActiveReportType;
  userId: unknown;
  contractNo: unknown;
  excludeClientSubmissionId?: unknown;
};

export function resolveSubmissionContractClaim(input: {
  contractNo: unknown;
  forceNew?: unknown;
  draftPreview?: boolean;
}): string | undefined {
  // Contract numbers are labels, not report identities. One contract can be
  // deliberately split across several reports, so admission is keyed only by
  // the stable client submission/session id. Keep this compatibility helper
  // while older callers and persisted rows are phased out.
  void input;
  return undefined;
}

export function resolvePersistedSubmissionContractIdentity(report: any): {
  bypassed: boolean;
  contractClaim?: string;
} {
  const bypassed = report?.submission_contract_claim_bypassed === true;
  if (bypassed) return { bypassed };
  return {
    bypassed: false,
    contractClaim:
      normalizeReportContractKey(
        report?.submission_contract_claim ||
          report?.contract_key ||
          report?.contract_no ||
          report?.preview_data?.contract_no,
      ) || undefined,
  };
}

export function isSubmissionContractClaimDuplicateKeyError(error: any): boolean {
  if (Number(error?.code) !== 11000) return false;
  if (error?.keyPattern?.submission_contract_claim) return true;
  if (error?.keyValue?.submission_contract_claim !== undefined) return true;
  return /submission_contract_claim|uniq_active_.*_contract_claim/i.test(
    String(error?.message || "")
  );
}

export async function findSubmissionContractClaimant(input: {
  reportType: ActiveReportType;
  userId: unknown;
  contractClaim: string;
}) {
  const model: any = input.reportType === "asset" ? AssetReport : LotListing;
  return model
    .findOne({
      user: input.userId,
      submission_contract_claim: input.contractClaim,
    })
    .select("+submission_contract_claim")
    .lean();
}

/**
 * A contract claim is unique only while an initial report is active. We keep
 * it on the report as a crash-safe lease and reclaim it with a state-guarded
 * update before a later appraisal/listing for the same contract is inserted.
 */
export async function releaseInactiveSubmissionContractClaim(input: {
  reportType: ActiveReportType;
  userId: unknown;
  contractClaim: string | undefined;
}): Promise<boolean> {
  void input;
  return false;
}

/**
 * Finds a submitted report that is actively processing for the same contract.
 *
 * Draft-preview reports are internal snapshots created while a user is still
 * editing a saved draft. They are intentionally excluded: treating one as a
 * submitted report prevents the complete draft revision from being accepted.
 */
export async function findActiveSameContractReport({
  reportType,
  userId,
  contractNo,
  excludeClientSubmissionId,
}: ActiveReportConflictInput) {
  // Retained temporarily for source compatibility with older controller paths.
  // Same-contract reports are valid and must never be treated as conflicts.
  void reportType;
  void userId;
  void contractNo;
  void excludeClientSubmissionId;
  return null;
}
