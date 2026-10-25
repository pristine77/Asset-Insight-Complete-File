import AssetReport from "../../models/asset.model.js";
import { prepareReportYoutubeVideos } from "../../service/youtubeVideoService.js";
import { generateAssetDocxFromReport } from "../../service/assetDocxService.js";
import { generateAssetSchedulePdfFromReport } from "../../service/assetSchedulePdfService.js";
import { generateAuctioneerSpecSheetPdfFromReport } from "../../service/auctioneerSpecSheetPdfService.js";
import { generateAuctioneerSpecSheetDocxFromReport } from "../../service/auctioneerSpecSheetDocxService.js";
import { generateAssetXlsxFromReport } from "../../service/xlsx/assetXlsxService.js";
import { generateScheduleAPdfFromReport } from "../../service/scheduleAReportPdfService.js";
import { notifyUser } from "../../service/notificationService.js";
import { sendEmail } from "../../utils/sendVerificationEmail.js";
import { isReviewReportOwnerId } from "../../service/reviewReportPolicy.js";
import { getR2PublicUrl } from "../../utils/r2Storage/r2Upload.js";
import { generateImagesZip } from "./imagesZip.js";
import { buildLotImageNameMaps, buildOrderedLotImageZipEntries } from "./imageNaming.js";
import { buildAssetVideoZipInputs } from "./videos.js";
import { normalizeLotsForReportOrdering } from "./lotOrdering.js";
import { enqueueReportJob } from "../../utils/reportJobQueue.js";
import { enrichAuctioneerImportSpecs } from "../../service/lotListingSpecEnrichmentService.js";
import {
  assignReportApprover,
} from "../../service/approvalAssignmentService.js";
import {
  assignReleaseManager,
} from "../../service/reportReleaseService.js";
import { sendClaimedAssignmentEmail } from "../../service/assignmentEmailClaimService.js";
import { normalizeLotsForBusinessRules } from "../../utils/previewLotNormalization.js";
import { markPreviewDataSpecsReviewed } from "../../utils/auctioneerSpecRows.js";
import {
  buildReportJobOutbox,
  createMongoReportJob,
  ensureReportJobOutbox,
  type ReportJobOutbox,
  type ReportJobExecutionContext,
  shouldUseMongoReportQueue,
} from "../../utils/reportJobMongoQueue.js";
import {
  buildReportArtifactFilenames,
  getReportContractNumber,
} from "../../utils/reportArtifactNames.js";
import { setReportGenerationProgress } from "../../service/reportGenerationProgressService.js";
import { syncAssetPreviewDataToRoot } from "../../utils/assetPreviewRootSync.js";
import {
  requiresAssetApproval,
  shouldEnterAssetApprovalQueue,
} from "../../utils/assetApprovalThreshold.js";
import { restoreEditedLotFields } from "./restoreEditedLotFields.js";
import { persistAssetGeneratedLots } from "../../service/assetGeneratedLotsPersistenceService.js";
import {
  buildImmutableAssetArtifactKey,
  stageAndPublishAssetArtifactBuffers,
} from "../../service/assetArtifactBufferPublicationService.js";
import type { ProposalValuationArtifactPublicationResult } from "../../service/proposalValuationArtifactPublicationService.js";
import { preserveAssetProposalValuationPreviewState } from "../../utils/assetProposalValuationPreviewState.js";
import {
  AssetPreviewFilesGenerationError,
  findAssetPreviewFilesJobByToken,
  reconcileAssetPreviewFilesWorkerFailure,
} from "../../service/assetPreviewFilesGenerationService.js";

export type PreviewFilesJobOptions = {
  previewDataSnapshot?: any;
  approveAfterGeneration?: boolean;
  targetStatus?: "preview" | "pending_approval" | "approved";
  jobId?: string;
  generationToken?: string;
  executionContext?: ReportJobExecutionContext;
  willRetryOnError?: boolean;
  /** Exact embedded outbox handoff already persisted with the report row. */
  reportJobOutboxToken?: string;
};

function clonePlain<T>(value: T): T {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function generationOwnershipFilter(
  generationToken?: string,
  executionToken?: string,
  jobStatus: "processing" | "done" | { $in: string[] } = "processing"
) {
  return generationToken
    ? {
        job_id: generationToken,
        ...(executionToken ? { job_execution_token: executionToken } : {}),
        job_status: jobStatus,
      }
    : {};
}

async function saveOwnedAssetReport(
  report: any,
  generationToken?: string,
  executionToken?: string
) {
  if (generationToken) {
    report.$where = generationOwnershipFilter(
      generationToken,
      executionToken
    );
  }
  try {
    await report.save();
  } catch (error: any) {
    if (
      generationToken &&
      (error?.name === "DocumentNotFoundError" || error?.name === "VersionError")
    ) {
      throw new AssetPreviewFilesGenerationError(
        `Asset file generation no longer owns report ${String(report?._id || "")}`,
        409,
        "ASSET_PREVIEW_FILES_OWNERSHIP_LOST"
      );
    }
    throw error;
  }
}

async function claimPendingScheduleRegeneration(
  reportId: string,
  generationToken?: string,
  executionToken?: string,
  options: { allowCompletedState?: boolean } = {}
) {
  return AssetReport.findOneAndUpdate(
    {
      _id: reportId,
      files_regeneration_pending: true,
      ...(generationToken
        ? {
            job_id: generationToken,
            ...(executionToken
              ? { job_execution_token: executionToken }
              : {}),
            job_status: options.allowCompletedState
              ? { $in: ["processing", "done"] }
              : "processing",
          }
        : {}),
    },
    {
      $set: {
        files_regeneration_pending: false,
        files_generating: true,
        files_regenerating: true,
        job_status: "processing",
        queued_at: new Date(),
      },
      $unset: { job_error: 1 },
    },
    { new: true }
  );
}

// Queue preview file generation in the background so request handling stays responsive.
function assetPreviewFilesQueueInput(
  reportId: string,
  options: PreviewFilesJobOptions
) {
  const previewDataSnapshot = clonePlain(options.previewDataSnapshot);
  const approveAfterGeneration = options.approveAfterGeneration === true;
  const targetStatus = options.targetStatus || (approveAfterGeneration ? "approved" : undefined);
  const generationToken = String(
    options.generationToken || options.jobId || ""
  ).trim();
  if (!generationToken) {
    throw new AssetPreviewFilesGenerationError(
      "Asset file generation is missing its ownership token.",
      500,
      "ASSET_PREVIEW_FILES_TOKEN_MISSING"
    );
  }

  return {
    type: "asset-preview-files" as const,
    reportId,
    progressId: generationToken,
    idempotencyKey: `asset-preview-files:${reportId}:${generationToken}`,
    payload: {
      reportId,
      previewDataSnapshot,
      approveAfterGeneration,
      targetStatus,
      generationToken,
    },
    priority: 1,
    maxAttempts: 3,
    targetStatus,
  };
}

export function buildAssetPreviewFilesJobOutbox(
  reportId: string,
  options: PreviewFilesJobOptions
): ReportJobOutbox {
  return buildReportJobOutbox(assetPreviewFilesQueueInput(reportId, options));
}

export async function queuePreviewFilesJob(
  reportId: string,
  options: PreviewFilesJobOptions = {}
): Promise<any> {
  const queueInput = assetPreviewFilesQueueInput(reportId, options);
  const generationToken = String(queueInput.progressId || "").trim();

  if (shouldUseMongoReportQueue()) {
    try {
      const job = options.reportJobOutboxToken
        ? await ensureReportJobOutbox(
            "asset",
            reportId,
            options.reportJobOutboxToken
          )
        : await createMongoReportJob(queueInput);
      if (
        !job ||
        String(job.progressId || "") !== generationToken ||
        String(job.payload?.generationToken || "") !== generationToken
      ) {
        throw new AssetPreviewFilesGenerationError(
          "Another file-generation request is still finishing. Retry this save after it completes."
        );
      }
      return job;
    } catch (error) {
      const exactJob = await findAssetPreviewFilesJobByToken({
        reportId,
        generationToken,
      }).catch(() => null);
      if (exactJob) return exactJob;
      if (error instanceof AssetPreviewFilesGenerationError) throw error;
      const conflicting = await AssetReport.exists({
        _id: reportId,
        job_id: { $ne: generationToken },
        job_status: { $in: ["queued", "processing"] },
      }).catch(() => null);
      if (conflicting || (error as any)?.code === 11000) {
        throw new AssetPreviewFilesGenerationError(
          "Another file-generation request is still finishing. Retry this save after it completes."
        );
      }
      throw error;
    }
  }

  enqueueReportJob(`asset-preview-files:${reportId}`, () =>
    runPreviewFilesJob(reportId, {
      previewDataSnapshot: queueInput.payload.previewDataSnapshot,
      approveAfterGeneration: queueInput.payload.approveAfterGeneration,
      targetStatus: queueInput.targetStatus,
      generationToken,
    }).catch((e) => {
        console.error("[PreviewFilesJob] Failed:", e);
      })
  );
  return { progressId: generationToken, status: "queued" };
}

// Merge report, preview, and user data into the payload consumed by file generators.
function buildPreviewReportData(
  report: any,
  user: any,
  previewDataSnapshot?: any
): any {
  const reportObject =
    report && typeof report.toObject === "function" ? report.toObject() : report || {};
  const previewData =
    previewDataSnapshot && typeof previewDataSnapshot === "object"
      ? previewDataSnapshot
      : reportObject.preview_data || (report as any)?.preview_data || {};
  const sourceLots = Array.isArray(previewData?.lots)
    ? previewData.lots
    : Array.isArray(reportObject?.lots)
      ? reportObject.lots
      : [];
  const reportData = {
    ...reportObject,
    ...previewData,
    // The persisted report media list is authoritative. Editable preview data
    // cannot introduce a remote URL that the DOCX generator would then fetch.
    imageUrls: Array.isArray(reportObject?.imageUrls)
      ? reportObject.imageUrls
      : [],
    inspector_name: user?.name || user?.username || "",
    user_email: user?.email || "",
    appraisal_company:
      (user as any)?.companyName ||
      previewData?.appraisal_company ||
      reportObject?.appraisal_company ||
      "",
    user_cv_url: (user as any)?.cvUrl || reportObject?.user_cv_url,
    user_cv_filename:
      (user as any)?.cvFilename || reportObject?.user_cv_filename,
  } as any;

  const normalizedLots = restoreEditedLotFields(
    normalizeLotsForBusinessRules(
      normalizeLotsForReportOrdering(
        Array.isArray(reportData?.lots) ? reportData.lots : [],
        reportData?.grouping_mode
      ),
      {
        defaultLocation: reportData?.location || reportData?.inspection_location,
        defaultLatitude: reportData?.latitude,
        defaultLongitude: reportData?.longitude,
        preserveDescription: true,
      }
    ),
    sourceLots
  );

  // Running Condition, Completeness and Legal remain structured lot data.
  // Export saved specs/selections without injecting selection summaries into
  // the appraiser description.
  reportData.lots = normalizedLots;
  report.lots = normalizedLots;

  return reportData;
}

export function getPreviewDataForJob(report: any, previewDataSnapshot?: any): any {
  const candidate =
    previewDataSnapshot && typeof previewDataSnapshot === "object"
      ? clonePlain(previewDataSnapshot)
      : clonePlain((report as any)?.preview_data || {});
  return preserveAssetProposalValuationPreviewState(
    candidate,
    (report as any)?.preview_data || {}
  );
}

function getSourceLotsForJob(report: any, previewData: any): any[] {
  if (Array.isArray(previewData?.lots)) return previewData.lots;
  if (Array.isArray((report as any)?.lots)) return (report as any).lots;
  return [];
}

function normalizeGeneratedLots(
  lots: any[],
  sourceLots: any[],
  defaultLocation?: string,
  defaultLatitude?: unknown,
  defaultLongitude?: unknown
): any[] {
  return restoreEditedLotFields(
    normalizeLotsForBusinessRules(lots, {
      defaultLocation,
      defaultLatitude,
      defaultLongitude,
      preserveDescription: true,
    }),
    sourceLots
  );
}

// Build stable image rename mappings for the downloadable image ZIP.
function buildPreviewRenameMap(report: any, reportData: any): Record<string, string> {
  const allUrls: string[] = Array.isArray((report as any)?.imageUrls)
    ? (report as any).imageUrls
    : [];
  const lotsForNames: any[] = Array.isArray(reportData?.lots)
    ? reportData.lots
    : [];
  return buildLotImageNameMaps(lotsForNames, allUrls).urlRenameMap;
}

function collectDeletedImageIndexes(reportData: any): Set<number> {
  const raw = Array.isArray(reportData?.deleted_image_indexes)
    ? reportData.deleted_image_indexes
    : Array.isArray(reportData?.preview_data?.deleted_image_indexes)
      ? reportData.preview_data.deleted_image_indexes
      : [];
  return new Set(
    raw
      .map((value: any) => Number(value))
      .filter((value: number) => Number.isInteger(value) && value >= 0)
  );
}

function buildPreviewZipInputs(report: any, reportData: any): {
  imageUrls: string[];
  filenames: string[];
} {
  const allUrls: string[] = Array.isArray((report as any)?.imageUrls)
    ? (report as any).imageUrls
    : [];
  const lotsForNames: any[] = Array.isArray(reportData?.lots)
    ? reportData.lots
    : [];
  const entries = buildOrderedLotImageZipEntries(
    lotsForNames,
    allUrls,
    Array.from(collectDeletedImageIndexes(reportData)),
    reportData?.deleted_image_urls
  );

  return {
    imageUrls: entries.map((entry) => entry.url),
    filenames: entries.map((entry) => entry.filename),
  };
}

// Upload freshly generated preview files and persist their CDN URLs back to the report.
async function uploadPreviewFiles(
  reportId: string,
  report: any,
  proposalValuationRevision: number,
  generationToken: string | undefined,
  executionToken: string | undefined,
  assertOwned: (() => Promise<void>) | undefined,
  publicUrlVersion: number,
  files: {
    pdfBuffer?: Buffer;
    specPdfBuffer?: Buffer;
    crDocxBuffer?: Buffer;
    scheduleAPdfBuffer: Buffer;
    docxBuffer: Buffer;
    xlsxBuffer: Buffer;
    imagesZip: Buffer;
  }
): Promise<ProposalValuationArtifactPublicationResult<void>> {
  const timestamp = publicUrlVersion;
  const artifactNames = buildReportArtifactFilenames({
    kind: "asset",
    contractNo: getReportContractNumber(report, reportId),
    reportId,
    fallback: reportId,
    lots: (report as any)?.preview_data?.lots || (report as any)?.lots,
  });
  const pdfFilename = `asset-preview-${reportId}.pdf`;
  const specPdfFilename = artifactNames.crPdf;
  const crDocxFilename = artifactNames.crDocx;
  const scheduleAPdfFilename = artifactNames.scheduleAPdf;
  const docxFilename = artifactNames.docx;
  const xlsxFilename = artifactNames.excel;
  const imagesFilename = artifactNames.imagesZip;

  const artifacts: Array<{
    field:
      | "pdf"
      | "spec_pdf"
      | "cr_docx"
      | "schedule_a_pdf"
      | "docx"
      | "excel"
      | "images";
    buffer: Buffer;
    contentType: string;
    key: string;
  }> = [];
  if (files.pdfBuffer) {
    artifacts.push({
      field: "pdf",
      buffer: files.pdfBuffer,
      contentType: "application/pdf",
      key: `previews/${pdfFilename}`,
    });
  }
  if (files.specPdfBuffer) {
    artifacts.push({
      field: "spec_pdf",
      buffer: files.specPdfBuffer,
      contentType: "application/pdf",
      key: `previews/${specPdfFilename}`,
    });
  }
  if (files.crDocxBuffer) {
    artifacts.push({
      field: "cr_docx",
      buffer: files.crDocxBuffer,
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      key: `previews/${crDocxFilename}`,
    });
  }
  artifacts.push(
    {
      field: "schedule_a_pdf",
      buffer: files.scheduleAPdfBuffer,
      contentType: "application/pdf",
      key: `previews/${scheduleAPdfFilename}`,
    },
    {
      field: "docx",
      buffer: files.docxBuffer,
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      key: `previews/${docxFilename}`,
    },
    {
      field: "excel",
      buffer: files.xlsxBuffer,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      key: `previews/${xlsxFilename}`,
    },
    {
      field: "images",
      buffer: files.imagesZip,
      contentType: "application/zip",
      key: `previews/${imagesFilename}`,
    }
  );

  const immutableArtifacts = await Promise.all(artifacts.map(async (artifact) => ({
    ...artifact,
    key: await buildImmutableAssetArtifactKey({
      reportId,
      revision: proposalValuationRevision,
      baseKey: artifact.key,
      buffer: artifact.buffer,
    }),
  })));
  const previewFiles = Object.fromEntries(
    immutableArtifacts.map((artifact) => [
      artifact.field,
      `${getR2PublicUrl(artifact.key)}?v=${timestamp}`,
    ])
  ) as Record<string, string>;

  console.log(
    `[PreviewFilesJob] Staging files for report ${reportId} at Proposal Valuation revision ${proposalValuationRevision}`
  );
  const publication = await stageAndPublishAssetArtifactBuffers({
    reportId,
    revision: proposalValuationRevision,
    artifacts: immutableArtifacts,
    previewFiles,
    claimFilter: generationOwnershipFilter(generationToken, executionToken),
    assertOwned,
    // A crashed publisher expires inside one minute. Waiting under this same
    // durable attempt prevents immediate retries from exhausting maxAttempts.
    waitForPublishLeaseMs: 70_000,
  });
  if (publication.published) {
    (report as any).preview_files = previewFiles as any;
    report.unmarkModified?.("preview_files");
  }
  return publication;
}

// Notify the report owner and, when needed, admin after preview files are fully ready.
async function notifyPreviewFileReady(
  report: any,
  user: any,
  options: {
    notifyAdmin?: boolean;
    approved?: boolean;
    assertOwned?: () => Promise<void>;
  } = {}
): Promise<void> {
  const { sendPreviewSubmittedEmail, sendAdminApprovalRequestEmail, sendReportApprovedEmail } =
    await import("../../service/assetEmailService.js");

  if (options.approved) {
    const awaitingRelease = String((report as any).release_status || "") === "pending_release";
    if (awaitingRelease) {
      const webUrl = process.env.WEB_APP_URL || "http://localhost:3000";
      await options.assertOwned?.();
      await sendEmail(
        user.email,
        "Asset Report Approved - Awaiting Release",
        `<div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#111827;">
          <h2>Report approved</h2>
          <p>Your asset report has been approved and is waiting for release before downloads are available.</p>
          <p><a href="${webUrl}/reports" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;">View Reports</a></p>
        </div>`
      );
    } else {
      await options.assertOwned?.();
      await sendReportApprovedEmail(
        user.email,
        user.name || user.username || "User",
        String(report._id)
      );
    }
  } else {
    await options.assertOwned?.();
    await sendPreviewSubmittedEmail(
      user.email,
      user.name || user.username || "User",
      String(report._id)
    );
  }

  const reviewOwner = await isReviewReportOwnerId(user?._id || report.user);
  if (options.notifyAdmin !== false && !reviewOwner) {
    const adminEmail = process.env.ADMIN_EMAIL || "admin@clearvalue.com";
    await options.assertOwned?.();
    await sendAdminApprovalRequestEmail(
      adminEmail,
      user.name || user.username || "User",
      user.email,
      String(report._id)
    );
  }

  console.log(
    `[PreviewFilesJob] Email sent to owner${options.notifyAdmin === false || reviewOwner ? "" : " and admin"}`
  );

  try {
    const awaitingRelease = options.approved && String((report as any).release_status || "") === "pending_release";
    await options.assertOwned?.();
    await notifyUser({
      userId: String(user?._id || report?.user || ""),
      tokens: Array.isArray(user?.expoPushTokens) ? user.expoPushTokens : [],
      category: "report",
      type: options.approved ? "report_approved" : "report_preview_ready",
      title: options.approved ? "Report Approved" : "Report Ready for Preview",
      body: options.approved
        ? awaitingRelease
          ? "Your asset report has been approved and is waiting for release."
          : "Your asset report has been approved and is ready for download."
        : "Your asset report has been generated and is ready for preview.",
      data: {
        type: options.approved ? "report_approved" : "report_preview_ready",
        reportId: String(report._id),
        reportType: "Asset",
      },
    });
    console.log("[PreviewFilesJob] Push notification sent to report owner");
  } catch (pushErr) {
    if (
      [
        "REPORT_JOB_OWNERSHIP_LOST",
        "ASSET_PREVIEW_FILES_EXECUTION_OWNERSHIP_LOST",
      ].includes(String((pushErr as any)?.code || ""))
    ) {
      throw pushErr;
    }
    console.error("[PreviewFilesJob] Push notification error:", pushErr);
  }
}

// Generate and upload preview-ready files for an existing preview report.
export async function runPreviewFilesJob(
  reportId: string,
  options: PreviewFilesJobOptions = {}
) {
  let report: any = null;
  let previousStatus: string | undefined;
  let isEditedRegeneration = false;
  let generationTarget: "preview" | "pending_approval" | "approved" | undefined;
  const generationToken = String(
    options.generationToken || options.jobId || ""
  ).trim();
  const executionContext = options.executionContext;
  const executionToken = String(executionContext?.executionToken || "").trim();
  const assertAttemptOwned = async (allowCompletedReport = false) => {
    if (!executionContext) return;
    if (!generationToken || !executionToken) {
      throw new AssetPreviewFilesGenerationError(
        `Asset file generation no longer owns report ${reportId}`,
        409,
        "ASSET_PREVIEW_FILES_EXECUTION_OWNERSHIP_LOST"
      );
    }
    await executionContext.assertOwned();
    const ownsReport = await AssetReport.exists({
      _id: reportId,
      ...generationOwnershipFilter(
        generationToken,
        executionToken,
        allowCompletedReport
          ? { $in: ["processing", "done"] }
          : "processing"
      ),
    });
    if (!ownsReport) {
      throw new AssetPreviewFilesGenerationError(
        `Asset file generation no longer owns report ${reportId}`,
        409,
        "ASSET_PREVIEW_FILES_EXECUTION_OWNERSHIP_LOST"
      );
    }
  };

  try {
    console.log(`[PreviewFilesJob] Starting for report ${reportId}`);
    if (executionContext && (!generationToken || !executionToken)) {
      throw new AssetPreviewFilesGenerationError(
        `Asset file generation no longer owns report ${reportId}`,
        409,
        "ASSET_PREVIEW_FILES_EXECUTION_OWNERSHIP_LOST"
      );
    }
    if (generationToken) {
      await executionContext?.assertOwned();
      report = await AssetReport.findOneAndUpdate(
        {
          _id: reportId,
          job_id: generationToken,
          files_generating: true,
          job_status: { $in: ["queued", "processing"] },
        },
        {
          $set: {
            job_status: "processing",
            ...(executionToken
              ? { job_execution_token: executionToken }
              : {}),
            processing_started_at: new Date(),
          },
          $unset: { job_error: 1 },
        },
        { new: true }
      ).populate("user");
      if (!report) {
        const alreadyCompleted = await AssetReport.exists({
          _id: reportId,
          job_id: generationToken,
          job_status: "done",
          files_generating: { $ne: true },
          files_regenerating: { $ne: true },
        });
        if (alreadyCompleted) {
          await executionContext?.assertOwned();
          return;
        }
        throw new AssetPreviewFilesGenerationError(
          `Asset file generation no longer owns report ${reportId}`,
          409,
          "ASSET_PREVIEW_FILES_OWNERSHIP_LOST"
        );
      }
      await assertAttemptOwned();
    } else {
      // Backward-compatible recovery for durable jobs created before generation
      // tokens were persisted. Every new producer supplies a token.
      report = await AssetReport.findById(reportId).populate("user");
    }
    if (!report) throw new Error(`Report ${reportId} not found`);
    if (!report.preview_data) {
      throw new Error(`Report ${reportId} missing preview_data`);
    }
    const proposalValuationGenerationRevision = Number(
      (report as any).proposal_valuation_revision || 0
    );
    await AssetReport.updateOne(
      {
        _id: reportId,
        ...generationOwnershipFilter(generationToken, executionToken),
      },
      {
        $set: {
          proposal_valuation_generation_revision:
            proposalValuationGenerationRevision,
        },
        $unset: {
          proposal_valuation_regeneration_claim_token: 1,
          proposal_valuation_regeneration_claimed_at: 1,
        },
      }
    );

    previousStatus = report.status;
    generationTarget =
      options.targetStatus ||
      (report as any).generation_target_status ||
      (options.approveAfterGeneration === true || previousStatus === "approved"
        ? "approved"
        : previousStatus === "pending_approval"
          ? "pending_approval"
          : undefined);
    isEditedRegeneration = Boolean((report as any).files_regenerating);
    (report as any).generation_target_status = generationTarget;
    if (!generationToken) {
      (report as any).job_status = "processing";
      (report as any).job_error = undefined;
      (report as any).processing_started_at = new Date();
      await report.save();
    }
    await setReportGenerationProgress({
      kind: "asset",
      reportId,
      progressId: generationToken || undefined,
      generationToken: generationToken || undefined,
      executionToken: executionToken || undefined,
      stage: "generating_files",
      progressPercent: 8,
      message: "Preparing the latest report data",
    });

    const user = report.user as any;
    const previewDataForJob = markPreviewDataSpecsReviewed(
      getPreviewDataForJob(report, options.previewDataSnapshot),
      { reconcileManualOverrides: false }
    );
    const hasReviewedPreviewLots = Array.isArray(previewDataForJob?.lots);
    syncAssetPreviewDataToRoot(report, previewDataForJob);
    // Proposal Valuation edits target a nested preview_data field while this
    // worker can run for minutes. Never persist the worker's stale Mixed
    // snapshot; only the explicitly synchronized root fields are saved here.
    report.unmarkModified?.("preview_data");
    await saveOwnedAssetReport(
      report,
      generationToken || undefined,
      executionToken || undefined
    );
    const sourceLots = getSourceLotsForJob(report, previewDataForJob);
    let reportData = buildPreviewReportData(report, user, previewDataForJob);
    await persistAssetGeneratedLots({
      reportId,
      lots: reportData.lots,
      derivedPreviewData: previewDataForJob,
      claimFilter: generationOwnershipFilter(generationToken, executionToken),
    });
    report.unmarkModified?.("lots");
    report.unmarkModified?.("preview_data");

    if ((report as any).is_merged_report !== true && !hasReviewedPreviewLots) {
      try {
        await assertAttemptOwned();
        const enrichment = await enrichAuctioneerImportSpecs({
          lots: Array.isArray(reportData?.lots) ? reportData.lots : [],
          currency: reportData?.currency,
          location: reportData?.location || reportData?.inspection_location,
          mode: "pictureOnly",
        });
        await assertAttemptOwned();
        const enrichedLots = normalizeGeneratedLots(
          enrichment.lots,
          sourceLots,
          reportData?.location || reportData?.inspection_location,
          reportData?.latitude,
          reportData?.longitude
        );
        reportData = { ...reportData, lots: enrichedLots };
        report.lots = enrichedLots;
        const nextAnalysis = {
          ...((report as any).analysis || {}),
          auctioneer_import_enrichment: enrichment.analyses,
        };
        (report as any).analysis = nextAnalysis;
        await persistAssetGeneratedLots({
          reportId,
          lots: enrichedLots,
          analysis: nextAnalysis,
          claimFilter: generationOwnershipFilter(
            generationToken,
            executionToken
          ),
        });
        report.unmarkModified?.("lots");
        report.unmarkModified?.("preview_data");
        report.unmarkModified?.("analysis");
      } catch (enrichmentError) {
        if (
          executionContext?.signal.aborted ||
          [
            "REPORT_JOB_OWNERSHIP_LOST",
            "ASSET_PREVIEW_FILES_EXECUTION_OWNERSHIP_LOST",
          ].includes(String((enrichmentError as any)?.code || ""))
        ) {
          throw enrichmentError;
        }
        console.warn(
          `[PreviewFilesJob] Auctioneer Import enrichment failed for report ${reportId}; continuing with existing lots:`,
          enrichmentError
        );
      }
    }

    console.log("");
    console.log("=".repeat(80));
    console.log("[PreviewFilesJob] Generating asset preview files");
    console.log("=".repeat(80));
    console.log(`Report ID: ${reportId}`);
    console.log(`User: ${user?.name || user?.username || "Unknown"} (${user?.email})`);
    console.log(
      `Prepared For: ${reportData.prepared_for || reportData.client_name || "NOT SET"}`
    );
    console.log(`CV URL: ${reportData.user_cv_url || "NOT PROVIDED - WILL SKIP CV"}`);
    console.log("=".repeat(80));
    console.log("");

    const scheduleAName = buildReportArtifactFilenames({
      kind: "asset",
      contractNo: getReportContractNumber(report, reportId),
      reportId,
      fallback: reportId,
      lots: reportData.lots,
    }).scheduleAPdf;
    const publicUrlVersion = Date.now();
    // Schedule A is content addressed along with every other generated Asset
    // artifact. Build it first so the DOCX/XLSX embed the exact immutable URL
    // that will be atomically published in preview_files below.
    const scheduleAPdfBuffer = await generateScheduleAPdfFromReport(reportData);
    const scheduleAPdfKey = await buildImmutableAssetArtifactKey({
      reportId,
      revision: proposalValuationGenerationRevision,
      baseKey: `previews/${scheduleAName}`,
      buffer: scheduleAPdfBuffer,
    });
    const scheduleAPdfUrl = `${getR2PublicUrl(scheduleAPdfKey)}?v=${publicUrlVersion}`;
    reportData = {
      ...reportData,
      schedule_a_pdf_url: scheduleAPdfUrl,
    };
    await prepareReportYoutubeVideos({
      reportType: "asset", reportId, enabled: report.youtube_videos_enabled,
      generationToken, lots: reportData.lots || [], assertOwned: assertAttemptOwned,
    });
    const [docxBuffer, xlsxBuffer] = await Promise.all([
      generateAssetDocxFromReport(reportData),
      generateAssetXlsxFromReport(reportData),
    ]);
    await setReportGenerationProgress({
      kind: "asset",
      reportId,
      progressId: generationToken || undefined,
      generationToken: generationToken || undefined,
      executionToken: executionToken || undefined,
      stage: "generating_files",
      progressPercent: 45,
      message: "Building report files",
    });

    let pdfBuffer: Buffer | undefined;
    let specPdfBuffer: Buffer | undefined;
    let crDocxBuffer: Buffer | undefined;
    try {
      pdfBuffer = await generateAssetSchedulePdfFromReport(reportData);
    } catch (pdfError) {
      console.error(
        `[PreviewFilesJob] Asset schedule PDF generation failed for report ${reportId}:`,
        pdfError
      );
    }
    try {
      specPdfBuffer = await generateAuctioneerSpecSheetPdfFromReport(reportData);
    } catch (specPdfError) {
      console.error(
        `[PreviewFilesJob] CR generation failed for report ${reportId}:`,
        specPdfError
      );
    }
    try {
      crDocxBuffer = await generateAuctioneerSpecSheetDocxFromReport(reportData);
    } catch (crDocxError) {
      console.error(
        `[PreviewFilesJob] CR DOCX generation failed for report ${reportId}:`,
        crDocxError
      );
    }

    console.log("[PreviewFilesJob] DOCX generated successfully");
    console.log(`Size: ${(docxBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(
      `Will be uploaded to the contract-based Asset DOCX filename for report ${reportId}`
    );

    const shouldEnhance =
      (report as any)?.enhance_images === true ||
      (report as any)?.details?.enhance_images === true ||
      (report as any)?.preview_data?.enhance_images === true;
    const zipInputs = buildPreviewZipInputs(report, reportData);
    const imagesZip = await generateImagesZip(
      zipInputs.imageUrls,
      buildPreviewRenameMap(report, reportData),
      {
        optimizeSize: true,
        maxSizeKB: 500,
        enhance: shouldEnhance,
        // Saved report photos already follow the upload watermark policy.
        // Editing/submitting a preview must not stamp those images again.
        watermark: false,
        filenames: zipInputs.filenames,
        rawFiles: buildAssetVideoZipInputs(reportData.lots, report.videoUrls),
      }
    );

    const latestProposalValuation = await AssetReport.findById(reportId)
      .select("proposal_valuation_revision")
      .lean();
    const latestProposalValuationRevision = Number(
      (latestProposalValuation as any)?.proposal_valuation_revision || 0
    );
    if (
      latestProposalValuationRevision !==
      proposalValuationGenerationRevision
    ) {
      // Discard this in-memory artifact snapshot before upload. The edit path
      // normally sets the pending flag itself; setting it here also covers an
      // edit committed between the worker's initial read and active-flag save.
      await assertAttemptOwned();
      await AssetReport.updateOne(
        {
          _id: reportId,
          ...generationOwnershipFilter(generationToken, executionToken),
        },
        { $set: { files_regeneration_pending: true } }
      );
      const revisionFollowUp = await claimPendingScheduleRegeneration(
        reportId,
        generationToken || undefined,
        executionToken || undefined
      );
      if (revisionFollowUp) {
        console.info(
          `[PreviewFilesJob] Proposal Valuation advanced from revision ${proposalValuationGenerationRevision} to ${latestProposalValuationRevision}; regenerating before upload`
        );
        return runPreviewFilesJob(reportId, {
          approveAfterGeneration: options.approveAfterGeneration,
          targetStatus: generationTarget,
          generationToken: generationToken || undefined,
          executionContext,
          willRetryOnError: options.willRetryOnError,
        });
      }
    }
    await setReportGenerationProgress({
      kind: "asset",
      reportId,
      progressId: generationToken || undefined,
      generationToken: generationToken || undefined,
      executionToken: executionToken || undefined,
      stage: "generating_files",
      progressPercent: 82,
      message: "Uploading generated files",
    });

    await assertAttemptOwned();
    const publication = await uploadPreviewFiles(
      reportId,
      report,
      proposalValuationGenerationRevision,
      generationToken || undefined,
      executionToken || undefined,
      executionContext ? () => assertAttemptOwned() : undefined,
      publicUrlVersion,
      {
        pdfBuffer,
        specPdfBuffer,
        crDocxBuffer,
        scheduleAPdfBuffer,
        docxBuffer,
        xlsxBuffer,
        imagesZip,
      }
    );
    if (!publication.published) {
      if (publication.reason === "publish-in-progress") {
        throw new Error(
          `Proposal Valuation artifacts are already publishing for revision ${proposalValuationGenerationRevision}`
        );
      }
      await assertAttemptOwned();
      await AssetReport.updateOne(
        {
          _id: reportId,
          ...generationOwnershipFilter(generationToken, executionToken),
        },
        { $set: { files_regeneration_pending: true } }
      );
      const revisionFollowUp = await claimPendingScheduleRegeneration(
        reportId,
        generationToken || undefined,
        executionToken || undefined
      );
      if (revisionFollowUp) {
        console.info(
          `[PreviewFilesJob] Proposal Valuation advanced to revision ${publication.currentRevision} during staging; regenerating before canonical publication`
        );
        return runPreviewFilesJob(reportId, {
          approveAfterGeneration: options.approveAfterGeneration,
          targetStatus: generationTarget,
          generationToken: generationToken || undefined,
          executionContext,
          willRetryOnError: options.willRetryOnError,
        });
      }
      throw new Error(
        "Proposal Valuation changed before canonical artifacts could be published"
      );
    }

    const pendingFollowUp = await claimPendingScheduleRegeneration(
      reportId,
      generationToken || undefined,
      executionToken || undefined
    );
    if (pendingFollowUp) {
      // A save made while this run was active has already persisted the latest
      // sheet. Re-run once from the database so stale artifacts never win.
      console.info(
        `[PreviewFilesJob] Running coalesced Schedule A regeneration for ${reportId}`
      );
      return runPreviewFilesJob(reportId, {
        approveAfterGeneration: options.approveAfterGeneration,
        targetStatus: generationTarget,
        generationToken: generationToken || undefined,
        executionContext,
        willRetryOnError: options.willRetryOnError,
      });
    }

    (report as any).files_regenerated_at = new Date();
    (report as any).files_regenerating = false;
    (report as any).files_generating = false;
    (report as any).job_status = "done";
    (report as any).job_error = undefined;
    (report as any).processing_completed_at = new Date();
    const shouldApproveAfterGeneration = options.approveAfterGeneration === true;

    // Revalidate the approval gate at completion so a stale queued target cannot
    // strand a low-value or unassigned report in manual approval after a restart.
    if (generationTarget === "pending_approval") {
      const thresholdExceeded = await requiresAssetApproval(report);
      const approverId = thresholdExceeded
        ? await assignReportApprover(report, { userId: user?._id || report.user })
        : null;
      if (!shouldEnterAssetApprovalQueue(thresholdExceeded, approverId)) {
        generationTarget = "approved";
        (report as any).approval_assigned_to = undefined;
        (report as any).approval_assigned_at = undefined;
        (report as any).approval_assigned_source = undefined;
        (report as any).approval_requested_at = undefined;
        (report as any).approval_assignment_email_sent_at = undefined;
      }
    }

    const finalStatus =
      generationTarget === "approved" || previousStatus === "approved" || shouldApproveAfterGeneration
        ? "approved"
        : generationTarget === "preview"
          ? "preview"
          : "pending_approval";
    report.status = finalStatus as any;
    (report as any).generation_target_status = undefined;
    const newlyApproved =
      finalStatus === "approved" && previousStatus !== "approved";
    if (finalStatus === "pending_approval") {
      report.approval_requested_at =
        report.approval_requested_at || new Date();
    } else if (newlyApproved || shouldApproveAfterGeneration) {
      (report as any).approval_processed_at = new Date();
      (report as any).approval_assigned_to = undefined;
      (report as any).approval_assigned_at = undefined;
      (report as any).approval_assigned_source = undefined;
      (report as any).approval_assignment_email_sent_at = undefined;
      await assertAttemptOwned();
      await assignReleaseManager(report, {
        userId: user?._id || report.user,
        forceManual: Boolean((report as any).auctioneerWorkItem),
      });
    }
    report.unmarkModified?.("preview_data");
    await saveOwnedAssetReport(
      report,
      generationToken || undefined,
      executionToken || undefined
    );
    await assertAttemptOwned(true);

    const latePendingFollowUp = await claimPendingScheduleRegeneration(
      reportId,
      generationToken || undefined,
      executionToken || undefined,
      { allowCompletedState: true }
    );
    if (latePendingFollowUp) {
      // Close the narrow race between the first pending check and final status
      // persistence. Saves after this check see an idle report and enqueue a
      // separate durable job through the controller.
      console.info(
        `[PreviewFilesJob] Running late coalesced Schedule A regeneration for ${reportId}`
      );
      return runPreviewFilesJob(reportId, {
        approveAfterGeneration: options.approveAfterGeneration,
        targetStatus: generationTarget,
        generationToken: generationToken || undefined,
        executionContext,
        willRetryOnError: options.willRetryOnError,
      });
    }

    const assignmentEmailGenerationToken =
      generationToken ||
      String((report as any).job_id || options.jobId || reportId);
    if (finalStatus === "pending_approval") {
      await assertAttemptOwned(true);
      await sendClaimedAssignmentEmail({
        model: AssetReport,
        reportId,
        kind: "approval",
        generationToken: assignmentEmailGenerationToken,
        ownershipFilter: {
          ...generationOwnershipFilter(
            generationToken || undefined,
            executionToken || undefined,
            "done",
          ),
          job_status: "done",
        },
        stateFilter: { status: "pending_approval" },
        reportType: "Asset",
        creatorUserId: user?._id || report.user,
        title:
          (report as any).client_name ||
          (report as any).preview_data?.client_name,
        summary:
          (report as any).preview_data?.contract_no ||
          (report as any).contract_no,
      });
    } else if (newlyApproved || shouldApproveAfterGeneration) {
      await assertAttemptOwned(true);
      await sendClaimedAssignmentEmail({
        model: AssetReport,
        reportId,
        kind: "release",
        generationToken: assignmentEmailGenerationToken,
        ownershipFilter: {
          ...generationOwnershipFilter(
            generationToken || undefined,
            executionToken || undefined,
            "done",
          ),
          job_status: "done",
        },
        stateFilter: {
          status: "approved",
          release_status: "pending_release",
        },
        reportType: "Asset",
        creatorUserId: user?._id || report.user,
        title:
          (report as any).client_name ||
          (report as any).preview_data?.client_name,
        summary:
          (report as any).preview_data?.contract_no ||
          (report as any).contract_no,
      });
    }

    await setReportGenerationProgress({
      kind: "asset",
      reportId,
      progressId: generationToken || undefined,
      generationToken: generationToken || undefined,
      executionToken: executionToken || undefined,
      stage:
        finalStatus === "approved"
          ? (report as any).release_status === "pending_release"
            ? "awaiting_release"
            : "ready"
          : finalStatus === "pending_approval"
            ? "awaiting_approval"
            : "building_preview",
      progressPercent: 100,
      message:
        finalStatus === "approved"
          ? (report as any).release_status === "pending_release"
            ? "Files ready; awaiting release"
            : "Report ready"
          : finalStatus === "pending_approval"
            ? "Files ready; awaiting approval"
            : "Preview ready",
    });

    console.log(`Files created for report ${reportId} (status: ${report.status})`);

    const stillOwnsCompletedReport = !generationToken || Boolean(
      await AssetReport.exists({
        _id: reportId,
        job_id: generationToken,
        ...(executionToken ? { job_execution_token: executionToken } : {}),
        job_status: "done",
      })
    );
    if (stillOwnsCompletedReport) {
      try {
        await assertAttemptOwned(true);
        if (finalStatus === "pending_approval" && !isEditedRegeneration) {
          await notifyPreviewFileReady(report, user, {
            notifyAdmin: true,
            assertOwned: () => assertAttemptOwned(true),
          });
        } else if (newlyApproved || shouldApproveAfterGeneration) {
          await notifyPreviewFileReady(report, user, {
            notifyAdmin: false,
            approved: true,
            assertOwned: () => assertAttemptOwned(true),
          });
        }
      } catch (notificationError) {
        if (
          executionContext?.signal.aborted ||
          [
            "REPORT_JOB_OWNERSHIP_LOST",
            "ASSET_PREVIEW_FILES_EXECUTION_OWNERSHIP_LOST",
          ].includes(String((notificationError as any)?.code || ""))
        ) {
          throw notificationError;
        }
        // Artifact publication is already complete and must not be replayed
        // because an optional notification provider is unavailable.
        console.error(
          `[PreviewFilesJob] Completion notification failed for ${reportId}:`,
          notificationError
        );
      }
    }

    if (executionContext) {
      await executionContext.assertOwned();
      const released = await AssetReport.updateOne(
        {
          _id: reportId,
          job_id: generationToken,
          job_execution_token: executionToken,
          job_status: "done",
        },
        { $unset: { job_execution_token: 1 } }
      );
      if (released.matchedCount !== 1) {
        throw new AssetPreviewFilesGenerationError(
          `Asset file generation no longer owns report ${reportId}`,
          409,
          "ASSET_PREVIEW_FILES_EXECUTION_OWNERSHIP_LOST"
        );
      }
    }

    console.log(`[PreviewFilesJob] Completed for report ${reportId}`);
  } catch (e) {
    const ownershipLost = Boolean(
      executionContext?.signal.aborted ||
        [
          "REPORT_JOB_OWNERSHIP_LOST",
          "ASSET_PREVIEW_FILES_OWNERSHIP_LOST",
          "ASSET_PREVIEW_FILES_EXECUTION_OWNERSHIP_LOST",
        ].includes(String((e as any)?.code || ""))
    );
    if (report && !ownershipLost) {
      try {
        const message = e instanceof Error ? e.message : String(e);
        const willRetry = options.willRetryOnError === true;
        // Preserve a genuinely approved report's prior state, but never turn a
        // pending report into approved when its replacement files failed.
        const fallbackStatus = previousStatus === "approved"
          ? "approved"
          : generationTarget === "pending_approval" ||
              previousStatus === "pending_approval"
            ? "pending_approval"
            : "error";
        await reconcileAssetPreviewFilesWorkerFailure({
          reportId,
          message,
          willRetry,
          fallbackStatus,
          generationTarget,
          progressId: generationToken || undefined,
          generationToken: generationToken || undefined,
          executionToken: executionToken || undefined,
        });
      } catch (saveError) {
        console.error(
          `[PreviewFilesJob] Failed to reset report flags for ${reportId}:`,
          saveError
        );
      }
    }
    console.error(`[PreviewFilesJob] Error for report ${reportId}:`, e);
    throw e;
  }
}
