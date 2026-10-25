import {
  buildAssetPreviewFilesJobOutbox,
  queuePreviewFilesJob,
} from "../jobs/assetReportJob.js";
import AssetReport from "../models/asset.model.js";
import ReportJob from "../models/reportJob.model.js";
import {
  shouldUseMongoReportQueue,
  type ReportJobOutbox,
} from "../utils/reportJobMongoQueue.js";
import {
  createAssetPreviewFilesGenerationToken,
  findAssetPreviewFilesJobByToken,
} from "./assetPreviewFilesGenerationService.js";

async function activeMongoFileGenerationJob(reportId: string) {
  if (!shouldUseMongoReportQueue()) return null;
  return ReportJob.findOne({
    reportId,
    type: { $in: ["asset-preview-files", "asset-excel-cr-files"] },
    status: { $in: ["queued", "processing"] },
  })
    .select("type progressId")
    .lean();
}

async function clearProposalValuationQueueClaim(
  reportId: string,
  claimToken: string
) {
  await AssetReport.updateOne(
    {
      _id: reportId,
      proposal_valuation_regeneration_claim_token: claimToken,
    },
    {
      $unset: {
        proposal_valuation_regeneration_claim_token: 1,
        proposal_valuation_regeneration_claimed_at: 1,
      },
    }
  );
}

async function ensureTaggedProposalValuationClaimIsQueued(
  reportId: string,
  claimToken: string,
  persistedOutbox?: ReportJobOutbox
): Promise<AssetScheduleSheetRegenerationResult> {
  let current: any = await AssetReport.findOne({
    _id: reportId,
    proposal_valuation_regeneration_claim_token: claimToken,
    job_id: claimToken,
  })
    .select("+report_job_outbox")
    .lean();
  if (!current) return { queued: true, coalesced: true };

  const queueOptions = {
    jobId: claimToken,
    generationToken: claimToken,
  };
  let outbox =
    (current.report_job_outbox as ReportJobOutbox | undefined) ||
    persistedOutbox;

  if (shouldUseMongoReportQueue()) {
    if (outbox) {
      const validOutbox =
        outbox.type === "asset-preview-files" &&
        String(outbox.reportId || "") === reportId &&
        String(outbox.progressId || "") === claimToken &&
        String(outbox.idempotencyKey || "") ===
          `asset-preview-files:${reportId}:${claimToken}`;
      if (!validOutbox) {
        throw Object.assign(
          new Error(
            "A different durable report operation already owns this Asset report."
          ),
          { code: "ASSET_REPORT_OUTBOX_CONFLICT", statusCode: 409 }
        );
      }
    } else {
      const candidate = buildAssetPreviewFilesJobOutbox(
        reportId,
        queueOptions
      );
      current = await AssetReport.findOneAndUpdate(
        {
          _id: reportId,
          proposal_valuation_regeneration_claim_token: claimToken,
          job_id: claimToken,
          "report_job_outbox.token": { $exists: false },
        },
        { $set: { report_job_outbox: candidate } },
        { returnDocument: "after" }
      )
        .select("+report_job_outbox")
        .lean();
      if (!current) {
        current = await AssetReport.findOne({
          _id: reportId,
          proposal_valuation_regeneration_claim_token: claimToken,
          job_id: claimToken,
        })
          .select("+report_job_outbox")
          .lean();
      }
      if (!current) return { queued: true, coalesced: true };
      outbox = current.report_job_outbox as ReportJobOutbox | undefined;
      if (
        !outbox ||
        outbox.type !== "asset-preview-files" ||
        String(outbox.reportId || "") !== reportId ||
        String(outbox.progressId || "") !== claimToken ||
        String(outbox.idempotencyKey || "") !==
          `asset-preview-files:${reportId}:${claimToken}`
      ) {
        throw Object.assign(
          new Error(
            "A different durable report operation already owns this Asset report."
          ),
          { code: "ASSET_REPORT_OUTBOX_CONFLICT", statusCode: 409 }
        );
      }
    }
  }

  try {
    await queuePreviewFilesJob(reportId, {
      ...queueOptions,
      reportJobOutboxToken: outbox?.token,
    });
    await clearProposalValuationQueueClaim(reportId, claimToken);
    return { queued: true, coalesced: false };
  } catch (error) {
    // A provider/driver error can be ambiguous after the durable insert. Resolve
    // that outcome before reporting failure or retaining the outbox claim.
    const exactJob = await findAssetPreviewFilesJobByToken({
      reportId,
      generationToken: claimToken,
    }).catch(() => null);
    if (exactJob) {
      await clearProposalValuationQueueClaim(reportId, claimToken);
      return { queued: true, coalesced: true };
    }
    console.error(
      `[ProposalValuation] Failed to enqueue artifact regeneration for ${reportId}:`,
      error
    );
    // Keep token + shared generation flags intact. They are the durable outbox
    // that lets an exact retry ensure the same-type deduplicated job exists;
    // reopening the flags here would let Excel/CR claim a parallel writer.
    return {
      queued: false,
      coalesced: false,
      warning:
        "Proposal Valuation was saved, but file regeneration could not be queued. Retry regeneration from the latest revision.",
    };
  }
}

export type AssetScheduleSheetRegenerationResult = {
  queued: boolean;
  coalesced: boolean;
  warning?: string;
};

/**
 * Queues the canonical Asset artifact regeneration after a Proposal Valuation
 * save. Active work is coalesced into one follow-up run so rapid saves never
 * create parallel writers for the same report artifacts.
 */
export async function queueAssetScheduleSheetRegeneration(
  reportId: string,
  revision?: number
): Promise<AssetScheduleSheetRegenerationResult> {
  const assetReport = await AssetReport.findById(reportId)
    .select(
      "+report_job_outbox files_generating files_regenerating excel_regenerating excel_regeneration_token excel_regeneration_expires_at files_regeneration_pending job_id job_status job_error queued_at proposal_valuation_revision proposal_valuation_generation_revision proposal_valuation_regeneration_claim_token proposal_valuation_regeneration_claimed_at"
    )
    .lean();
  if (!assetReport) return { queued: false, coalesced: false };

  const storedRevision = Number(
    (assetReport as any).proposal_valuation_revision || 0
  );
  const generationRevision =
    Number.isInteger(revision) && Number(revision) >= 0
      ? Number(revision)
      : storedRevision;

  let excelRegenerationActive = Boolean(
    (assetReport as any).excel_regenerating
  );
  const excelRegenerationExpiresAt = (assetReport as any)
    .excel_regeneration_expires_at;
  if (
    excelRegenerationActive &&
    excelRegenerationExpiresAt &&
    new Date(excelRegenerationExpiresAt).getTime() <= Date.now()
  ) {
    await AssetReport.updateOne(
      {
        _id: reportId,
        excel_regeneration_token: (assetReport as any)
          .excel_regeneration_token,
        excel_regeneration_expires_at: { $lte: new Date() },
      },
      {
        $set: { excel_regenerating: false },
        $unset: {
          excel_regeneration_token: 1,
          excel_regeneration_expires_at: 1,
        },
      }
    );
    excelRegenerationActive = false;
  }

  const generationActive =
    Boolean(
      (assetReport as any).files_generating ||
        (assetReport as any).files_regenerating ||
        excelRegenerationActive
    ) ||
    ["queued", "processing"].includes(String((assetReport as any).job_status || ""));

  const fileGenerationClaimActive = Boolean(
    (assetReport as any).files_generating ||
      (assetReport as any).files_regenerating ||
      ["queued", "processing"].includes(
        String((assetReport as any).job_status || "")
      )
  );
  const queueClaimToken = String(
    (assetReport as any).proposal_valuation_regeneration_claim_token || ""
  );
  const persistedOutbox = (assetReport as any)
    .report_job_outbox as ReportJobOutbox | undefined;
  const activeFileJob = fileGenerationClaimActive
    ? await activeMongoFileGenerationJob(reportId)
    : null;
  const activeFileJobToken = String((activeFileJob as any)?.progressId || "");
  const activeFileJobIsLegacy = Boolean(
    activeFileJob &&
      !activeFileJobToken &&
      !String((assetReport as any).job_id || "")
  );
  const activeFileJobMatchesClaim = Boolean(
    activeFileJob &&
      queueClaimToken &&
      (activeFileJobToken === queueClaimToken || activeFileJobIsLegacy)
  );
  if (activeFileJob && queueClaimToken && !activeFileJobMatchesClaim) {
    // A different durable file job already owns the report. A stale PV queue
    // claim must never replace that job_id/execution token or dispatch a
    // parallel artifact writer. Coalesce the latest PV revision behind the
    // current owner and retire only the exact stale PV handoff. The active
    // worker will observe files_regeneration_pending at completion and queue
    // one fresh regeneration from the latest persisted revision.
    const stalePvOutbox =
      persistedOutbox?.type === "asset-preview-files" &&
      String(persistedOutbox.reportId || "") === reportId &&
      String(persistedOutbox.progressId || "") === queueClaimToken &&
      String(persistedOutbox.idempotencyKey || "") ===
        `asset-preview-files:${reportId}:${queueClaimToken}`;
    const update = {
      $set: { files_regeneration_pending: true },
      $unset: {
        proposal_valuation_regeneration_claim_token: 1,
        proposal_valuation_regeneration_claimed_at: 1,
        ...(stalePvOutbox ? { report_job_outbox: 1 } : {}),
      },
    };
    const retired = await AssetReport.updateOne(
      {
        _id: reportId,
        proposal_valuation_regeneration_claim_token: queueClaimToken,
        ...(stalePvOutbox
          ? { "report_job_outbox.token": persistedOutbox.token }
          : {}),
      },
      update
    );
    if (retired.matchedCount !== 1) {
      // A concurrent transition changed the stale claim/outbox. Setting the
      // follow-up bit is always safe and deliberately leaves its new owner
      // untouched.
      await AssetReport.updateOne(
        { _id: reportId },
        { $set: { files_regeneration_pending: true } }
      );
    }
    return { queued: true, coalesced: true };
  }
  if (activeFileJobMatchesClaim) {
    if (persistedOutbox?.token) {
      const accepted = await ensureTaggedProposalValuationClaimIsQueued(
        reportId,
        queueClaimToken,
        persistedOutbox
      );
      if (!accepted.queued) return accepted;
    } else {
      await clearProposalValuationQueueClaim(reportId, queueClaimToken);
    }
  }
  if (
    activeFileJobMatchesClaim &&
    (activeFileJob as any)?.type === "asset-preview-files" &&
    Number((assetReport as any).proposal_valuation_generation_revision || 0) >=
      generationRevision
  ) {
    // An exact retry of the same (or older) requested revision is already
    // durably covered. Do not request a redundant follow-up run.
    return { queued: true, coalesced: true };
  }
  if (
    fileGenerationClaimActive &&
    queueClaimToken &&
    !activeFileJobMatchesClaim
  ) {
    // The tagged report claim is a durable outbox. Keep the shared flags closed
    // while ensuring the same-type deduplicated job exists, so an Excel/CR
    // producer can never enter between recovery writes.
    await AssetReport.updateOne(
      {
        _id: reportId,
        proposal_valuation_regeneration_claim_token: queueClaimToken,
      },
      {
        $max: {
          proposal_valuation_generation_revision: generationRevision,
        },
        $set: {
          job_id: queueClaimToken,
          job_status: "queued",
        },
        $unset: { job_execution_token: 1 },
      }
    );
    return ensureTaggedProposalValuationClaimIsQueued(
      reportId,
      queueClaimToken,
      persistedOutbox
    );
  }

  if (generationActive) {
    await AssetReport.updateOne(
      { _id: reportId },
      { $set: { files_regeneration_pending: true } }
    );
    return { queued: true, coalesced: true };
  }

  const claimToken = createAssetPreviewFilesGenerationToken();
  const claimedAt = new Date();
  const queueOptions = {
    jobId: claimToken,
    generationToken: claimToken,
  };
  const outbox = shouldUseMongoReportQueue()
    ? buildAssetPreviewFilesJobOutbox(reportId, queueOptions)
    : undefined;
  const claimed = await AssetReport.findOneAndUpdate(
    {
      _id: reportId,
      files_generating: { $ne: true },
      files_regenerating: { $ne: true },
      excel_regenerating: { $ne: true },
      job_status: { $nin: ["queued", "processing"] },
      "report_job_outbox.token": { $exists: false },
    },
    {
      $set: {
        files_regeneration_pending: false,
        files_generating: true,
        files_regenerating: true,
        job_id: claimToken,
        job_status: "queued",
        proposal_valuation_generation_revision: generationRevision,
        proposal_valuation_regeneration_claim_token: claimToken,
        proposal_valuation_regeneration_claimed_at: claimedAt,
        queued_at: claimedAt,
        generation_progress: {
          stage: "generating_files",
          progressPercent: 1,
          message: "Queued to regenerate report files",
          updatedAt: claimedAt,
        },
        ...(outbox ? { report_job_outbox: outbox } : {}),
      },
      $unset: {
        job_error: 1,
        job_execution_token: 1,
        ...(!outbox ? { report_job_outbox: 1 } : {}),
      },
    },
    { new: true }
  );
  if (!claimed) {
    await AssetReport.updateOne(
      { _id: reportId },
      { $set: { files_regeneration_pending: true } }
    );
    return { queued: true, coalesced: true };
  }
  return ensureTaggedProposalValuationClaimIsQueued(
    reportId,
    claimToken,
    outbox
  );
}
