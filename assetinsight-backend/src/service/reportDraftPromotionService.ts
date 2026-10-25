import { randomUUID } from "node:crypto";
import ReportDraft from "../models/reportDraft.model.js";
import ReportJob from "../models/reportJob.model.js";
import {
  releaseInactiveSubmissionContractClaim,
  resolveSubmissionContractClaim,
} from "./reportSubmissionConflictService.js";

const PROMOTION_CLAIM_LEASE_MS = 2 * 60 * 1000;

export function reportDraftPromotionClaimCutoff(now = Date.now()): Date {
  return new Date(now - PROMOTION_CLAIM_LEASE_MS);
}

export type ReportDraftPromotionClaim = {
  draftId: string;
  reportId: string;
  revision: number;
  token: string;
  resumed: boolean;
  /** The retained draft's explicit duplicate override, carried into promotion. */
  forceNew?: boolean;
  /** Canonical active-contract claim applied atomically when the report is saved. */
  submissionContractClaim?: string;
};

export class ReportDraftPromotionError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 409, code = "DRAFT_PROMOTION_CONFLICT") {
    super(message);
    this.name = "ReportDraftPromotionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function draftForceNew(draft: any): boolean {
  return [true, "true", 1, "1"].includes(
    draft?.formData?.force_new as any
  );
}

function draftSubmissionContractClaim(draft: any): string | undefined {
  return resolveSubmissionContractClaim({
    contractNo: draft?.contractNo || draft?.formData?.contract_no,
    forceNew: draftForceNew(draft),
  });
}

async function releaseInactiveDraftPromotionContractClaim(input: {
  draft: any;
  userId: unknown;
  type: "asset" | "lotListing";
}) {
  const submissionContractClaim = draftSubmissionContractClaim(input.draft);
  await releaseInactiveSubmissionContractClaim({
    reportType: input.type,
    userId: input.userId,
    contractClaim: submissionContractClaim,
  });
  return submissionContractClaim;
}

export function applyReportDraftPromotionContractClaim(
  report: any,
  claim: ReportDraftPromotionClaim
) {
  report.set(
    "submission_contract_claim",
    claim.submissionContractClaim || undefined
  );
  report.set(
    "submission_contract_claim_bypassed",
    claim.forceNew === true ? true : undefined,
  );
  return claim.submissionContractClaim;
}

export function isReportDraftPromotionClaimStale(
  claimedAt: unknown,
  now = Date.now()
): boolean {
  const timestamp = new Date(claimedAt as any).getTime();
  return !Number.isFinite(timestamp) || timestamp <= reportDraftPromotionClaimCutoff(now).getTime();
}

export async function findCurrentReportFileGenerationJob(input: {
  report: any;
  type: "asset" | "lotListing";
}) {
  const reportId = String(input.report?._id || "");
  if (!reportId) return null;

  const filter: Record<string, unknown> = {
    type: input.type === "asset" ? "asset-preview-files" : "lot-listing-files",
    reportId,
    status: { $in: ["queued", "processing", "completed"] },
  };
  const progressId = String(input.report?.job_id || "").trim();
  if (progressId) {
    filter.progressId = progressId;
  } else {
    const queuedAt = new Date(input.report?.queued_at as any);
    if (!Number.isFinite(queuedAt.getTime())) return null;
    // Older completed jobs for the same report must not prove that this
    // submission was queued. File jobs are created after queued_at is saved.
    filter.createdAt = { $gte: queuedAt };
  }

  return ReportJob.findOne(filter).sort({ createdAt: -1 }).lean();
}

/**
 * Claim a revision-bound, ready draft preview before its hidden report is made
 * visible. Retaining the consumed draft makes retries idempotent without
 * deleting media that the promoted report may still reference.
 */
export async function claimReportDraftPreviewPromotion(input: {
  draftId: unknown;
  reportId: unknown;
  userId: unknown;
  revision: unknown;
  type: "asset" | "lotListing";
  submit: boolean;
}): Promise<ReportDraftPromotionClaim> {
  const draftId = String(input.draftId || "");
  const reportId = String(input.reportId || "");
  const revision = Number(input.revision);
  const existing: any = await ReportDraft.findOne({
    _id: draftId as any,
    user: input.userId as any,
  });
  if (!existing) {
    throw new ReportDraftPromotionError("Draft not found.", 404, "DRAFT_NOT_FOUND");
  }

  if (existing.type !== input.type) {
    throw new ReportDraftPromotionError(
      "This draft preview does not match the requested report type.",
      409,
      "UNSUPPORTED_DRAFT_TYPE"
    );
  }

  if (existing.promotedAt) {
    throw new ReportDraftPromotionError(
      String(existing.promotedReportId || "") === reportId
        ? "This draft preview was already moved."
        : "This draft was already moved to another report.",
      409,
      "DRAFT_ALREADY_PROMOTED"
    );
  }

  if (existing.promotionToken) {
    if (String(existing.promotedReportId || "") !== reportId) {
      throw new ReportDraftPromotionError(
        "This draft is already being moved to another report.",
        409,
        "DRAFT_PROMOTION_CONFLICT"
      );
    }
    if (!isReportDraftPromotionClaimStale(existing.promotionClaimedAt)) {
      throw new ReportDraftPromotionError(
        "This draft preview is already being moved. Wait a moment and try again.",
        409,
        "DRAFT_PROMOTION_IN_PROGRESS"
      );
    }

    const submissionContractClaim =
      await releaseInactiveDraftPromotionContractClaim({
        draft: existing,
        userId: input.userId,
        type: input.type,
      });
    const replacementToken = randomUUID();
    const reclaimed: any = await ReportDraft.findOneAndUpdate(
      {
        _id: existing._id,
        user: input.userId as any,
        promotedAt: null,
        promotionToken: existing.promotionToken,
        promotionClaimedAt: existing.promotionClaimedAt,
      },
      {
        $set: {
          promotionToken: replacementToken,
          promotionClaimedAt: new Date(),
          promotedSubmitted: input.submit,
        },
      },
      { new: true }
    );
    if (!reclaimed) {
      throw new ReportDraftPromotionError(
        "This draft changed while it was being moved. Refresh and try again.",
        409,
        "DRAFT_PROMOTION_CONFLICT"
      );
    }
    return {
      draftId,
      reportId,
      revision: Number(reclaimed.revision || revision || 0),
      token: replacementToken,
      resumed: false,
      forceNew: draftForceNew(reclaimed),
      submissionContractClaim,
    };
  }

  if (String(existing.previewStatus || "") !== "ready") {
    throw new ReportDraftPromotionError(
      "Prepare this draft preview and wait for it to finish before moving it.",
      409,
      "DRAFT_PREVIEW_NOT_READY"
    );
  }
  if (
    !Number.isInteger(revision) ||
    Number(existing.revision || 0) !== revision ||
    Number(existing.previewProcessedRevision ?? -1) !== revision ||
    String(existing.previewReportId || "") !== reportId
  ) {
    throw new ReportDraftPromotionError(
      "This draft changed after its preview was prepared. Prepare the latest revision first.",
      409,
      "STALE_DRAFT_PREVIEW"
    );
  }

  // Direct and upload-session submissions release a completed report's stale
  // claim before attempting the unique active-contract insert. Draft promotion
  // must use the same rule or an old approved report can strand a ready draft.
  const submissionContractClaim =
    await releaseInactiveDraftPromotionContractClaim({
      draft: existing,
      userId: input.userId,
      type: input.type,
    });
  const token = randomUUID();
  const claimed: any = await ReportDraft.findOneAndUpdate(
    {
      _id: existing._id,
      user: input.userId as any,
      type: input.type,
      previewStatus: "ready",
      previewReportId: existing.previewReportId,
      revision,
      previewProcessedRevision: revision,
      promotedAt: null,
      promotionToken: null,
    },
    {
      $set: {
        promotedReportId: existing.previewReportId,
        promotedSubmitted: input.submit,
        promotionToken: token,
        promotionClaimedAt: new Date(),
      },
    },
    { new: true }
  );
  if (!claimed) {
    throw new ReportDraftPromotionError(
      "This draft changed while it was being moved. Refresh and try again.",
      409,
      "DRAFT_PROMOTION_CONFLICT"
    );
  }

  return {
    draftId,
    reportId,
    revision,
    token,
    resumed: false,
    forceNew: draftForceNew(claimed),
    submissionContractClaim,
  };
}

/** Claim and unhide a report created by the draft-preview worker. */
export async function claimHiddenReportDraftPromotion(input: {
  report: any;
  userId: unknown;
  type: "asset" | "lotListing";
  submit: boolean;
}): Promise<ReportDraftPromotionClaim | null> {
  const report = input.report;
  if (report?.is_draft_preview !== true) return null;
  if (!report?.source_draft_id) {
    throw new ReportDraftPromotionError(
      "This draft preview is missing its source draft.",
      409,
      "DRAFT_SOURCE_MISSING"
    );
  }
  const claim = await claimReportDraftPreviewPromotion({
    draftId: report.source_draft_id,
    reportId: report._id,
    userId: input.userId,
    revision: report.source_draft_revision,
    type: input.type,
    submit: input.submit,
  });
  applyReportDraftPromotionContractClaim(report, claim);
  report.is_draft_preview = false;
  return claim;
}

/** Make a failed, non-committed promotion visible in Draft Previews again. */
export async function rollbackReportDraftPreviewPromotion(
  claim: ReportDraftPromotionClaim | null | undefined
) {
  if (!claim || claim.resumed || !claim.token) return;
  await ReportDraft.updateOne(
    {
      _id: claim.draftId as any,
      promotedReportId: claim.reportId as any,
      promotionToken: claim.token,
    },
    {
      $unset: {
        promotedReportId: 1,
        promotedAt: 1,
        promotedSubmitted: 1,
        promotionToken: 1,
        promotionClaimedAt: 1,
      },
    }
  );
}

/** Clear only the transient claim token; the retained row remains consumed. */
export async function completeReportDraftPreviewPromotion(
  claim: ReportDraftPromotionClaim | null | undefined
) {
  if (!claim || !claim.token) return;
  await ReportDraft.updateOne(
    {
      _id: claim.draftId as any,
      promotedReportId: claim.reportId as any,
      promotionToken: claim.token,
    },
    {
      $set: { promotedAt: new Date() },
      $unset: { promotionToken: 1, promotionClaimedAt: 1 },
    }
  );
}
