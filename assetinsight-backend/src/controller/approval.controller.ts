import { withCurrencyBaseRevision } from "../service/reportCurrencyConversionService.js";
import { resolvePhotoWatermark } from "../utils/photoWatermarkPolicy.js";
/**
 * Approver queue and report-decision HTTP boundary.
 *
 * Approval handlers verify that the authenticated approver owns the assignment,
 * generated artifacts are ready, and the report is pending before atomically claiming
 * a decision. Preview correction endpoints preserve the same assignment scope.
 */
import { Request, Response } from "express";
import mongoose from "mongoose";
import PdfReport from "../models/pdfReport.model.js";
import { salvageApprovalAcknowledgement } from "../service/salvageApprovalReview.js";
import AssetReport from "../models/asset.model.js";
import RealEstateReport from "../models/realEstate.model.js";
import LotListing from "../models/lotListing.model.js";
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";
import { notifyUser } from "../service/notificationService.js";
import {
  approvalAssignedPopulatePath,
  assignedApprovalDeniedMessage,
  canProcessAssignedApproval,
  mergeApprovalScope,
} from "../service/approvalAssignmentService.js";
import {
  buildAssetPreviewFilesJobOutbox,
  queuePreviewFilesJob,
} from "../jobs/assetReportJob.js";
import { queueRealEstateFilesJob } from "../jobs/realEstateReportJob.js";
import {
  buildLotListingFilesJobOutbox,
  regenerateLotListingFiles,
} from "../jobs/lotListingJob.js";
import { normalizePreviewDataAuctioneerSpecs } from "../utils/auctioneerSpecRows.js";
import { normalizePreviewLotNumbers } from "../utils/lotNumbers.js";
import { normalizeReviewedPreviewLotsForBusinessRules } from "../utils/reviewedPreviewNormalization.js";
import { sanitizeAssetPreviewSignature } from "../utils/assetPreviewSignature.js";
import { getPreviewLotPhotoLimitMessage } from "../utils/assetPhotoLimits.js";
import {
  appendImagesToPreviewLot,
  collectPreviewImageUploadFiles,
  parseMultipartPreviewData,
} from "../utils/previewLotImageUpload.js";
import { cleanupMulterFiles } from "../utils/reportTempFiles.js";
import {
  generateAndStoreAssetCrArtifacts,
  generateAndStoreLotListingCrArtifacts,
} from "../service/auctioneerSpecPdfRefreshService.js";
import {
  assertLegacyPdfReportGroupFilesReady,
  assertReportFilesReadyForWorkflow,
  assignReleaseManager,
  approvalAutomaticallyReleases,
  markReportAutoReleased,
  sendAssignedReleaseEmail,
  assertCurrentSalvagePdfArtifact,
  filterCurrentPdfReportArtifacts,
  currentPdfArtifactAggregationStages,
  pdfReportSiblingFilter,
} from "../service/reportReleaseService.js";
import { getReportPreviewPayloadById } from "../service/reportPreviewService.js";
import { preserveAssetProposalValuationPreviewState } from "../utils/assetProposalValuationPreviewState.js";
import { saveAssetReportWithProtectedPreviewData } from "../service/assetPreviewDataPersistenceService.js";
import {
  createAssetPreviewFilesGenerationToken,
  reconcileAssetPreviewFilesQueueFailure,
} from "../service/assetPreviewFilesGenerationService.js";
import { ensureActiveAssetPreviewFilesHandoff } from "../service/assetPreviewFilesHandoffService.js";
import {
  isLotListingArtifactPublicationLive,
  lotListingArtifactPublicationAvailableCondition,
} from "../service/lotListingArtifactPublicationService.js";
import {
  lotListingPreviewFingerprint,
  matchesLotListingGenerationSnapshot,
  stableLotListingPreviewJson,
} from "../utils/lotListingGenerationIdentity.js";
import { normalizeLotListingValuationMethods } from "../utils/lotListingValuationMethods.js";
import { findCurrentReportFileGenerationJob } from "../service/reportDraftPromotionService.js";
import { buildLotListingPreviewPersistence } from "../utils/lotListingPreviewPersistence.js";
import { restoreScheduleAItemLinks } from "../service/auctioneerReportLinkService.js";
import {
  ensureReportJobOutbox,
  shouldUseMongoReportQueue,
  type ReportJobOutbox,
} from "../utils/reportJobMongoQueue.js";
import {
  claimReportApprovalDecision,
  releaseFieldsForApprovalDecision,
} from "../service/reportApprovalDecisionService.js";
import {
  assetPreviewFingerprint,
  matchesAssetGenerationSnapshot,
} from "../utils/assetGenerationIdentity.js";

function clonePlain<T>(value: T): T {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function assignedLotListingGenerationActive(report: any): boolean {
  return (
    isLotListingArtifactPublicationLive(report) ||
    (report?.status === "processing" &&
      (report?.files_generating === true ||
        report?.files_regenerating === true ||
        ["queued", "processing"].includes(String(report?.job_status || ""))))
  );
}

function assignedAssetGenerationActive(report: any): boolean {
  return Boolean(
    report?.files_generating === true ||
      report?.files_regenerating === true ||
      ["queued", "processing"].includes(String(report?.job_status || ""))
  );
}

async function saveAssignedLotListingPreviewCas(input: {
  report: any;
  approverId: string;
  set: Record<string, unknown>;
  unset?: Record<string, 1>;
}) {
  const updated = await LotListing.findOneAndUpdate(
    {
      _id: input.report._id,
      approval_assigned_to: input.approverId as any,
      status: input.report.status,
      ...(input.report.updatedAt ? { updatedAt: input.report.updatedAt } : {}),
      files_generating: { $ne: true },
      files_regenerating: { $ne: true },
      job_status: { $nin: ["queued", "processing"] },
      ...lotListingArtifactPublicationAvailableCondition(),
    },
    {
      $set: input.set,
      ...(input.unset ? { $unset: input.unset } : {}),
    },
    { returnDocument: "after" }
  ).populate("user", "email username name companyName");
  if (!updated) {
    throw Object.assign(
      new Error(
        "This assigned Lot Listing changed or started generating files. Refresh before saving again."
      ),
      { code: "LOT_LISTING_PREVIEW_WRITE_CONFLICT", statusCode: 409 }
    );
  }
  return updated;
}

async function reconcileAssignedLotListingQueueFailure(input: {
  report: any;
  generationToken: string;
  error: unknown;
}): Promise<boolean> {
  const durableJob = await findCurrentReportFileGenerationJob({
    report: { _id: input.report._id, job_id: input.generationToken },
    type: "lotListing",
  });
  if (durableJob) return true;

  const message = input.error instanceof Error
    ? input.error.message
    : "Lot Listing files could not be queued.";
  await LotListing.updateOne(
    {
      _id: input.report._id,
      job_id: input.generationToken,
      job_status: "queued",
    },
    {
      $set: {
        status: "pending_approval",
        files_generating: false,
        files_regenerating: false,
        job_status: "error",
        job_error: message,
        processing_completed_at: new Date(),
        "generation_progress.stage": "error",
        "generation_progress.progressPercent": 100,
        "generation_progress.message": message,
        "generation_progress.updatedAt": new Date(),
      },
      $unset: { job_execution_token: 1 },
    }
  );
  return false;
}

async function ensureAssignedLotListingGenerationHandoff(report: any) {
  const reportId = String(report?._id || "");
  const generationToken = String(report?.job_id || "");
  if (!reportId || !generationToken || !shouldUseMongoReportQueue()) return;

  let current: any = await LotListing.findById(reportId)
    .select("+report_job_outbox")
    .lean();
  if (!current || String(current.job_id || "") !== generationToken) {
    throw Object.assign(
      new Error(
        "The assigned Lot Listing changed while its worker handoff was being recovered. Refresh and retry."
      ),
      { code: "LOT_LISTING_QUEUE_HANDOFF_CHANGED", statusCode: 409 }
    );
  }

  let outboxToken = String(current.report_job_outbox?.token || "");
  if (outboxToken) {
    await ensureReportJobOutbox("lotListing", reportId, outboxToken);
    return;
  }
  if (
    await findCurrentReportFileGenerationJob({
      report: current,
      type: "lotListing",
    })
  ) {
    return;
  }

  const assignedUser = report.user;
  const queueInput: Parameters<typeof regenerateLotListingFiles>[0] = {
    listingId: reportId,
    user: {
      id: String(assignedUser?._id || assignedUser || current.user || ""),
      email: String(assignedUser?.email || ""),
      name: assignedUser?.name || assignedUser?.username || undefined,
    },
    generationToken,
    previewDataSnapshot: clonePlain(current.preview_data || report.preview_data),
  };
  const outbox = buildLotListingFilesJobOutbox(
    queueInput,
    current.generation_target_status === "approved"
      ? "approved"
      : "pending_approval"
  );
  const claimed = await LotListing.updateOne(
    {
      _id: reportId,
      job_id: generationToken,
      job_status: { $in: ["queued", "processing"] },
      $or: [
        { report_job_outbox: { $exists: false } },
        { report_job_outbox: null },
      ],
      $and: [
        {
          $or: [
            { job_execution_token: { $exists: false } },
            { job_execution_token: null },
          ],
        },
      ],
    },
    { $set: { report_job_outbox: outbox } }
  );
  if (claimed.matchedCount === 1) {
    outboxToken = outbox.token;
  } else {
    current = await LotListing.findById(reportId)
      .select("+report_job_outbox")
      .lean();
    outboxToken = String(current?.report_job_outbox?.token || "");
    if (!outboxToken) {
      if (
        await findCurrentReportFileGenerationJob({
          report: current,
          type: "lotListing",
        })
      ) {
        return;
      }
      throw Object.assign(
        new Error(
          "The assigned Lot Listing worker handoff changed. Retry after refreshing the report."
        ),
        { code: "LOT_LISTING_QUEUE_HANDOFF_CHANGED", statusCode: 409 }
      );
    }
  }

  try {
    await regenerateLotListingFiles({
      ...queueInput,
      reportJobOutboxToken: outboxToken,
    });
  } catch (error) {
    const accepted = await findCurrentReportFileGenerationJob({
      report: current || report,
      type: "lotListing",
    }).catch(() => null);
    if (accepted) return;
    throw Object.assign(
      new Error(
        "The assigned Lot Listing and its exact processing request are saved, but the worker handoff could not be confirmed. Retry this request."
      ),
      {
        code: "LOT_LISTING_QUEUE_HANDOFF_PENDING",
        statusCode: 503,
        cause: error,
      }
    );
  }
}

function preserveCrDisclaimers(nextPreviewData: any, previousPreviewData: any) {
  if (!nextPreviewData || typeof nextPreviewData !== "object") return nextPreviewData;
  return {
    // Owner 2026-10-28: an approver's edit never drops a lot's Schedule A
    // item link; the appraiser chose it and Send still checks it.
    ...restoreScheduleAItemLinks(nextPreviewData, previousPreviewData),
    ...(!nextPreviewData.cr_disclaimers && previousPreviewData?.cr_disclaimers
      ? { cr_disclaimers: previousPreviewData.cr_disclaimers }
      : {}),
    ...(!nextPreviewData.cr_disclaimers_by_lot && previousPreviewData?.cr_disclaimers_by_lot
      ? { cr_disclaimers_by_lot: previousPreviewData.cr_disclaimers_by_lot }
      : {}),
  };
}

function sendAssignedPreviewMutationError(
  res: Response,
  error: any,
  fallbackMessage: string
) {
  const statusCode = Number(error?.statusCode);
  if (
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode < 500
  ) {
    return res.status(statusCode).json({
      ...(error?.code ? { code: String(error.code) } : {}),
      message: error?.message || fallbackMessage,
      ...(Number.isInteger(Number(error?.currentRevision))
        ? { currentRevision: Number(error.currentRevision) }
        : {}),
      ...(Number.isInteger(Number(error?.retryAfterMs)) &&
      Number(error.retryAfterMs) > 0
        ? { retryAfterMs: Number(error.retryAfterMs) }
        : {}),
    });
  }
  return res.status(500).json({ message: fallbackMessage });
}

function normalizeAssignedAssetPreviewData(nextPreviewData: any, previousPreviewData: any) {
  const signatureResult = sanitizeAssetPreviewSignature(nextPreviewData);
  if (signatureResult.message) return { message: signatureResult.message };

  const lotNumberResult = normalizePreviewLotNumbers(signatureResult.data, previousPreviewData);
  if (lotNumberResult.message) return { message: lotNumberResult.message };

  const data = preserveAssetProposalValuationPreviewState(
    preserveCrDisclaimers(
      normalizePreviewDataAuctioneerSpecs(
        normalizeReviewedPreviewLotsForBusinessRules(lotNumberResult.data, {
          preserveDescription: true,
        })
      ),
      previousPreviewData
    ),
    previousPreviewData
  );
  const photoLimitMessage = getPreviewLotPhotoLimitMessage(data);
  if (photoLimitMessage) return { message: photoLimitMessage };

  return { data };
}

function formatAssetApprovalItem(report: any) {
  const currency: string = String(report.preview_data?.currency || report.currency || "CAD").toUpperCase();
  const baseFMV: number | undefined = report.preview_data?.valuation_data?.baseFMV as number | undefined;
  const lots: any[] = Array.isArray(report.preview_data?.lots)
    ? report.preview_data.lots
    : Array.isArray(report.lots)
      ? report.lots
      : [];
  const sumFromLots = lots.reduce((acc: number, lot: any) => {
    const raw = typeof lot?.estimated_value === "string" ? lot.estimated_value : "";
    const num = parseFloat(String(raw).replace(/[^0-9.-]+/g, ""));
    return acc + (Number.isFinite(num) ? num : 0);
  }, 0);
  const total = Number.isFinite(baseFMV as any) ? (baseFMV as number) : sumFromLots;
  const fmvStr =
    total > 0
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency,
          maximumFractionDigits: 0,
        }).format(total)
      : currency;
  return {
    _id: report._id,
    filename: `${report.client_name || "Asset Report"}.docx`,
    address: report.client_name || report.preview_data?.client_name || "Asset Report",
    fairMarketValue: fmvStr,
    reportType: "Asset",
    createdAt: report.createdAt,
    updatedAt: report.updatedAt || report.createdAt,
    user: report.user,
    contract_no: report.preview_data?.contract_no || report.contract_no || undefined,
    fileType: "asset-preview",
    approvalStatus: "pending",
    approval_assigned_to: report.approval_assigned_to || null,
    report: report._id,
    isAssetReport: true,
    preview_files: report.preview_files,
    files_regenerating: report.files_regenerating || false,
    auctioneer_work_item_id: report.auctioneerWorkItem || undefined,
  };
}

function formatRealEstateApprovalItem(report: any) {
  const previewData = report.preview_data || {};
  const fmv =
    previewData.valuation?.fair_market_value ||
    previewData.farmland_valuation?.fair_market_value_formatted ||
    report.farmland_valuation?.fair_market_value_formatted ||
    "N/A";
  const address =
    previewData.property_details?.address ||
    report.property_details?.address ||
    "Real Estate Report";
  return {
    _id: report._id,
    filename: `${address}.docx`,
    address,
    fairMarketValue: fmv,
    reportType: "RealEstate",
    createdAt: report.createdAt,
    updatedAt: report.updatedAt || report.createdAt,
    user: report.user,
    contract_no: undefined,
    fileType: "realestate-preview",
    approvalStatus: "pending",
    approval_assigned_to: report.approval_assigned_to || null,
    report: report._id,
    isRealEstateReport: true,
    preview_files: report.preview_files,
    property_type: report.property_type,
    language: report.language,
  };
}

function formatLotListingApprovalItem(report: any) {
  const previewData = report.preview_data || {};
  const contractNo = previewData.contract_no || report.contract_no || "Lot Listing";
  const location = previewData.location || report.location || "";
  const currency = String(previewData.currency || report.currency || "CAD").toUpperCase();
  const total = Number(previewData.total_value ?? report.total_value);
  const fairMarketValue = Number.isFinite(total) && total > 0
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(total)
    : currency;

  return {
    _id: report._id,
    filename: `${contractNo}.xlsx`,
    address: location ? `${contractNo} - ${location}` : contractNo,
    fairMarketValue,
    reportType: "LotListing",
    createdAt: report.createdAt,
    updatedAt: report.updatedAt || report.createdAt,
    user: report.user,
    contract_no: contractNo,
    fileType: "lot-listing-preview",
    approvalStatus: "pending",
    approval_assigned_to: report.approval_assigned_to || null,
    report: report._id,
    isLotListing: true,
    preview_files: report.preview_files,
    files_regenerating: report.files_regenerating || false,
    auctioneer_work_item_id: report.auctioneerWorkItem || undefined,
  };
}

// List pending reports for approval (admins and superadmins)
export const getPendingReports = async (req: Request, res: Response) => {
  try {
    const page = Math.max(parseInt((req.query.page as string) || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "20", 10) || 20, 1), 200);

    // Get pending PdfReports (old workflow)
    const adminUser = (req as any).user;
    const filter: any = mergeApprovalScope({ approvalStatus: "pending" }, adminUser);
    const groupsAgg = await (PdfReport as any).aggregate([
      { $match: filter },
      ...currentPdfArtifactAggregationStages(),
      { $group: { _id: { $ifNull: ["$report", "$_id"] }, maxCreatedAt: { $max: "$createdAt" } } },
      { $sort: { maxCreatedAt: -1 } },
      { $facet: {
        total: [{ $count: "count" }],
        groups: [
          { $skip: (page - 1) * limit },
          { $limit: limit }
        ]
      }}
    ]);

    const pdfTotal = groupsAgg?.[0]?.total?.[0]?.count || 0;
    const reportIds = (groupsAgg?.[0]?.groups || []).map((g: any) => g._id);
    const pdfItems = reportIds.length > 0 ? await PdfReport.find({
      ...filter,
      $or: reportIds.map((id: any) => id ? { report: id } : { _id: id, report: { $exists: false } })
    })
      .populate("user", "email username")
      .populate(approvalAssignedPopulatePath())
      .sort({ createdAt: -1 }) : [];

    // Get pending AssetReports (new preview workflow)
    const unassignedAssetApprovalFilter = {
      status: "pending_approval",
      is_draft_preview: { $ne: true },
      $or: [
        { approval_assigned_to: { $exists: false } },
        { approval_assigned_to: null },
      ],
    };
    const assetReports = await AssetReport.find(mergeApprovalScope(unassignedAssetApprovalFilter, adminUser))
      .populate("user", "email username")
      .populate(approvalAssignedPopulatePath())
      .sort({ createdAt: -1 })
      .limit(limit);

    // Get pending RealEstateReports (real estate preview workflow)
    const realEstateReports = await RealEstateReport.find(mergeApprovalScope({ status: 'pending_approval' }, adminUser))
      .populate("user", "email username")
      .populate(approvalAssignedPopulatePath())
      .sort({ createdAt: -1 })
      .limit(limit);

    // Convert AssetReports to match the PdfReport format for the UI
    const assetItems = assetReports.map((report: any) => {
      const currency: string = String(report.preview_data?.currency || report.currency || 'CAD').toUpperCase();
      const baseFMV: number | undefined = (report.preview_data?.valuation_data?.baseFMV as number | undefined);
      const lots: any[] = Array.isArray(report.preview_data?.lots) ? report.preview_data.lots : (Array.isArray(report.lots) ? report.lots : []);
      const sumFromLots = (lots || []).reduce((acc: number, lot: any) => {
        const raw = typeof lot?.estimated_value === 'string' ? lot.estimated_value : '';
        const num = parseFloat(String(raw).replace(/[^0-9.-]+/g, ''));
        return acc + (Number.isFinite(num) ? num : 0);
      }, 0);
      const total = Number.isFinite(baseFMV as any) ? (baseFMV as number) : sumFromLots;
      const fmvStr = total > 0 ? new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(total) : currency;
      return {
        _id: report._id,
        filename: `${report.client_name || 'Asset Report'}.docx`,
        address: report.client_name || report.preview_data?.client_name || 'Asset Report',
        fairMarketValue: fmvStr,
        reportType: 'Asset',
        createdAt: report.createdAt,
        updatedAt: report.updatedAt || report.createdAt, // Include updatedAt for sorting
        user: report.user,
        contract_no: report.preview_data?.contract_no || undefined,
        fileType: 'asset-preview', // Special type to identify AssetReports
        approvalStatus: 'pending',
        approval_assigned_to: (report as any).approval_assigned_to || null,
        report: report._id, // Use _id as report group
        isAssetReport: true, // Flag to identify this is an AssetReport
        preview_files: report.preview_files, // Include preview file URLs
        files_regenerating: (report as any).files_regenerating || false, // Track if files are being regenerated
      };
    });

    // Convert RealEstateReports to match the PdfReport format for the UI
    const realEstateItems = realEstateReports.map((report: any) => {
      const previewData = report.preview_data || {};
      const fmv = previewData.valuation?.fair_market_value || 
                  previewData.farmland_valuation?.fair_market_value_formatted || 
                  report.farmland_valuation?.fair_market_value_formatted || 
                  'N/A';
      const address = previewData.property_details?.address || 
                      report.property_details?.address || 
                      'Real Estate Report';
      return {
        _id: report._id,
        filename: `${address}.docx`,
        address: address,
        fairMarketValue: fmv,
        reportType: 'RealEstate',
        createdAt: report.createdAt,
        updatedAt: report.updatedAt || report.createdAt, // Include updatedAt for sorting
        user: report.user,
        contract_no: undefined,
        fileType: 'realestate-preview', // Special type to identify RealEstateReports
        approvalStatus: 'pending',
        approval_assigned_to: (report as any).approval_assigned_to || null,
        report: report._id, // Use _id as report group
        isRealEstateReport: true, // Flag to identify this is a RealEstateReport
        preview_files: report.preview_files, // Include preview file URLs
        property_type: report.property_type,
        language: report.language,
      };
    });
    // Combine all lists and sort by most recently created or updated first
    const allItems = [
      ...assetItems,
      ...realEstateItems,
      ...await filterCurrentPdfReportArtifacts(pdfItems),
    ].sort((a: any, b: any) => {
      // Use the most recent of createdAt or updatedAt for each item
      const aLatest = Math.max(new Date(a.createdAt).getTime(), new Date(a.updatedAt || a.createdAt).getTime());
      const bLatest = Math.max(new Date(b.createdAt).getTime(), new Date(b.updatedAt || b.createdAt).getTime());
      return bLatest - aLatest;
    });
    const total =
      assetReports.length +
      realEstateReports.length +
      pdfTotal;

    return res.status(200).json({ items: allItems, total, page, limit });
  } catch (e) {
    console.error("getPendingReports error", e);
    return res.status(500).json({ message: "Failed to fetch pending reports" });
  }
};

export const getAssignedApprovals = async (req: any, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const reviewOwner: Record<string, any> = req.user?.isReviewAccount === true ? { user: new mongoose.Types.ObjectId(String(userId)) } : {};

    const [assetReports, realEstateReports, lotListings, pdfReports] = await Promise.all([
      AssetReport.find({ ...reviewOwner, status: "pending_approval", approval_assigned_to: userId, is_draft_preview: { $ne: true } })
        .populate("user", "email username")
        .populate(approvalAssignedPopulatePath())
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(100),
      RealEstateReport.find({ ...reviewOwner, status: "pending_approval", approval_assigned_to: userId })
        .populate("user", "email username")
        .populate(approvalAssignedPopulatePath())
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(100),
      LotListing.find({
        ...reviewOwner,
        status: "pending_approval",
        approval_assigned_to: userId,
        auctioneerWorkItem: null,
        is_draft_preview: { $ne: true },
      })
        .populate("user", "email username")
        .populate(approvalAssignedPopulatePath())
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(100),
      (async () => {
        const current = await (PdfReport as any).aggregate([
          { $match: { ...reviewOwner, approvalStatus: "pending", approval_assigned_to: new mongoose.Types.ObjectId(String(userId)) } },
          ...currentPdfArtifactAggregationStages(),
          { $sort: { createdAt: -1 } }, { $limit: 300 }, { $project: { _id: 1 } },
        ]);
        return PdfReport.find({ _id: { $in: current.map((row: any) => row._id) } })
          .populate("user", "email username")
          .populate(approvalAssignedPopulatePath())
          .sort({ createdAt: -1 });
      })(),
    ]);

    const groupedPdf = new Map<string, any>();
    for (const report of await filterCurrentPdfReportArtifacts(pdfReports as any[])) {
      const key = String(report.report || report._id);
      if (!groupedPdf.has(key)) groupedPdf.set(key, report);
    }

    const items = [
      ...assetReports.map(formatAssetApprovalItem),
      ...realEstateReports.map(formatRealEstateApprovalItem),
      ...lotListings.map(formatLotListingApprovalItem),
      ...Array.from(groupedPdf.values()),
    ].sort((a: any, b: any) => {
      const aLatest = Math.max(new Date(a.createdAt).getTime(), new Date(a.updatedAt || a.createdAt).getTime());
      const bLatest = Math.max(new Date(b.createdAt).getTime(), new Date(b.updatedAt || b.createdAt).getTime());
      return bLatest - aLatest;
    });

    return res.status(200).json({ items, total: items.length });
  } catch (e) {
    console.error("getAssignedApprovals error", e);
    return res.status(500).json({ message: "Failed to fetch assigned approvals" });
  }
};

async function verifyAssignedApprovalForUser(id: string, userId: string) {
  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(userId)) {
    return false;
  }
  const reportId = new mongoose.Types.ObjectId(id);
  const assignedUserId = new mongoose.Types.ObjectId(userId);
  const [assetReport, realEstateReport, lotListing, pdfReport] = await Promise.all([
    (AssetReport as any).findOne({
      _id: reportId,
      status: { $in: ["pending_approval", "approved", "declined"] },
      approval_assigned_to: assignedUserId,
      is_draft_preview: { $ne: true },
    }).select("_id").lean(),
    (RealEstateReport as any).findOne({
      _id: reportId,
      status: { $in: ["pending_approval", "approved", "declined"] },
      approval_assigned_to: assignedUserId,
    }).select("_id").lean(),
    (LotListing as any).findOne({
      _id: reportId,
      status: { $in: ["pending_approval", "approved", "declined"] },
      approval_assigned_to: assignedUserId,
      auctioneerWorkItem: null,
      is_draft_preview: { $ne: true },
    }).select("_id").lean(),
    (PdfReport as any).findOne({
      _id: reportId,
      approvalStatus: { $in: ["pending", "approved", "rejected"] },
      approval_assigned_to: assignedUserId,
    }).select("_id").lean(),
  ]);
  return Boolean(assetReport || realEstateReport || lotListing || pdfReport);
}

export const approveAssignedApproval = async (req: any, res: Response) => {
  try {
    const userId = req.userId;
    const id = String(req.params.id || "");
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const canAccess = await verifyAssignedApprovalForUser(id, userId);
    if (!canAccess) {
      return res.status(403).json({ message: "This report is not assigned to you for approval." });
    }
    const user = await User.findById(userId).select("_id email username role").lean();
    if (!user) return res.status(401).json({ message: "Unauthorized" });
    req.user = user;
    return approveReport(req, res);
  } catch (e) {
    console.error("approveAssignedApproval error", e);
    return res.status(500).json({ message: "Failed to approve assigned report" });
  }
};

export const rejectAssignedApproval = async (req: any, res: Response) => {
  try {
    const userId = req.userId;
    const id = String(req.params.id || "");
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const canAccess = await verifyAssignedApprovalForUser(id, userId);
    if (!canAccess) {
      return res.status(403).json({ message: "This report is not assigned to you for approval." });
    }
    const user = await User.findById(userId).select("_id email username role").lean();
    if (!user) return res.status(401).json({ message: "Unauthorized" });
    req.user = user;
    return rejectReport(req, res);
  } catch (e) {
    console.error("rejectAssignedApproval error", e);
    return res.status(500).json({ message: "Failed to reject assigned report" });
  }
};

async function findAssignedAssetApprovalReport(id: string, userId: string) {
  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }
  return AssetReport.findOne({
    _id: new mongoose.Types.ObjectId(id),
    status: "pending_approval",
    approval_assigned_to: new mongoose.Types.ObjectId(userId),
    is_draft_preview: { $ne: true },
  } as any).populate("user", "email username name companyName");
}

async function findAssignedRealEstateApprovalReport(id: string, userId: string) {
  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }
  return RealEstateReport.findOne({
    _id: new mongoose.Types.ObjectId(id),
    status: "pending_approval",
    approval_assigned_to: new mongoose.Types.ObjectId(userId),
  } as any).populate("user", "email username name companyName");
}

async function findAssignedLotListingApprovalReport(id: string, userId: string) {
  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }
  return LotListing.findOne({
    _id: new mongoose.Types.ObjectId(id),
    approval_assigned_to: new mongoose.Types.ObjectId(userId),
    auctioneerWorkItem: null,
    is_draft_preview: { $ne: true },
    $or: [
      { status: "pending_approval" },
      {
        status: { $in: ["processing", "error"] },
        // Keep the original assignee's retry access until publication clears
        // the assignment, including new auto-release and legacy targets.
        generation_target_status: { $in: ["pending_approval", "approved"] },
      },
    ],
  } as any)
    .select("+report_job_outbox")
    .populate("user", "email username name companyName");
}

async function findAssignedEditableApprovalReport(id: string, userId: string) {
  const [assetReport, realEstateReport, lotListing] = await Promise.all([
    findAssignedAssetApprovalReport(id, userId),
    findAssignedRealEstateApprovalReport(id, userId),
    findAssignedLotListingApprovalReport(id, userId),
  ]);
  if (assetReport) return { reportType: "Asset" as const, report: assetReport };
  if (realEstateReport) return { reportType: "RealEstate" as const, report: realEstateReport };
  if (lotListing) return { reportType: "LotListing" as const, report: lotListing };
  return null;
}

function buildAssignedAssetPreviewPayload(report: any) {
  return {
    reportType: "Asset",
    status: report.status,
    files_generating: (report as any).files_generating || false,
    files_regenerating: (report as any).files_regenerating || false,
    preview_data: withCurrencyBaseRevision(report),
    preview_files: (report as any).preview_files,
    grouping_mode: report.grouping_mode,
    image_count: Array.isArray((report as any).imageUrls) ? (report as any).imageUrls.length : 0,
    imageUrls: (report as any).imageUrls || [],
    reportId: report._id,
    createdAt: (report as any).createdAt,
    preview_submitted_at: (report as any).preview_submitted_at,
    approval_requested_at: (report as any).approval_requested_at,
    job_error: (report as any).job_error,
    auctioneer_work_item_id: (report as any).auctioneerWorkItem || undefined,
  };
}

function buildAssignedRealEstatePreviewPayload(report: any) {
  return {
    reportType: "RealEstate",
    status: report.status,
    files_generating: (report as any).files_generating || false,
    files_regenerating: (report as any).files_regenerating || false,
    preview_data: report.preview_data,
    preview_files: (report as any).preview_files,
    language: (report as any).language,
    property_type: (report as any).property_type,
    image_count: Array.isArray((report as any).imageUrls) ? (report as any).imageUrls.length : 0,
    imageUrls: (report as any).imageUrls || [],
    extraImageUrls: (report as any).extraImageUrls || [],
    extra_image_count: Array.isArray((report as any).extraImageUrls) ? (report as any).extraImageUrls.length : 0,
    reportId: report._id,
    createdAt: (report as any).createdAt,
    preview_submitted_at: (report as any).preview_submitted_at,
    approval_requested_at: (report as any).approval_requested_at,
    job_error: (report as any).job_error,
  };
}

function buildAssignedLotListingPreviewPayload(report: any) {
  return {
    reportType: "LotListing",
    status: report.status,
    files_generating: (report as any).files_generating || false,
    files_regenerating: (report as any).files_regenerating || false,
    preview_data: withCurrencyBaseRevision(report),
    preview_files: (report as any).preview_files,
    files: (report as any).files,
    image_count: Array.isArray((report as any).imageUrls) ? (report as any).imageUrls.length : 0,
    imageUrls: (report as any).imageUrls || [],
    reportId: report._id,
    createdAt: (report as any).createdAt,
    preview_submitted_at: (report as any).preview_submitted_at,
    approval_requested_at: (report as any).approval_requested_at,
    job_error: (report as any).job_error,
    auctioneer_work_item_id: (report as any).auctioneerWorkItem || undefined,
  };
}

function normalizeAssignedRealEstatePreviewData(nextPreviewData: any) {
  if (!nextPreviewData || typeof nextPreviewData !== "object" || Array.isArray(nextPreviewData)) {
    return { message: "preview_data is required" };
  }
  return { data: clonePlain(nextPreviewData) };
}

function normalizeAssignedLotListingPreviewData(
  nextPreviewData: any,
  previousPreviewData: any
) {
  if (!nextPreviewData || typeof nextPreviewData !== "object" || Array.isArray(nextPreviewData)) {
    return { message: "preview_data is required" };
  }
  const incoming = clonePlain(nextPreviewData);
  const mergedPreviewData = {
    ...(previousPreviewData || {}),
    ...incoming,
    lots: Object.prototype.hasOwnProperty.call(incoming, "lots")
      ? incoming.lots
      : previousPreviewData?.lots || [],
  };
  const lotNumberResult = normalizePreviewLotNumbers(
    mergedPreviewData,
    previousPreviewData
  );
  if (lotNumberResult.message) return { message: lotNumberResult.message };

  const valuationMethods = normalizeLotListingValuationMethods(
    lotNumberResult.data?.valuation_methods,
    normalizeLotListingValuationMethods(previousPreviewData?.valuation_methods)
  );
  if (valuationMethods.length === 0) {
    return { message: "Select at least one supported valuation method" };
  }

  return {
    data: preserveCrDisclaimers(
      normalizePreviewDataAuctioneerSpecs(
        normalizeReviewedPreviewLotsForBusinessRules(
          {
            ...lotNumberResult.data,
            valuation_methods: valuationMethods,
          },
          { preserveDescription: true }
        )
      ),
      previousPreviewData
    ),
  };
}

export const getAssignedAssetApprovalPreview = async (req: any, res: Response) => {
  try {
    const userId = String(req.userId || "");
    const id = String(req.params.id || "");
    const found = await findAssignedEditableApprovalReport(id, userId);
    if (!found) {
      if (mongoose.isValidObjectId(id) && mongoose.isValidObjectId(userId)) {
        const pdf = await (PdfReport as any).findOne({ _id: new mongoose.Types.ObjectId(id), reportModel: "SalvageReport", approval_assigned_to: new mongoose.Types.ObjectId(userId),
          approvalStatus: { $in: ["pending", "approved", "rejected"] } }).lean();
        if (pdf) {
          await assertLegacyPdfReportGroupFilesReady(pdf);
          const preview = await getReportPreviewPayloadById(id);
          if (preview) return res.status(200).json({ message: "Assigned preview data fetched successfully", data: {
            reportType: "Salvage", reportId: preview.reportId || String(pdf.report),
            status: pdf.approvalStatus === "approved" ? "approved" : pdf.approvalStatus === "rejected" ? "declined" : "pending_approval",
            preview_data: preview.data, imageUrls: preview.data.image_urls || [], revision: preview.revision,
            files_generating: false, files_regenerating: false, read_only: true,
          } });
        }
      }
      return res.status(404).json({ message: "Assigned report not found" });
    }
    const data =
      found.reportType === "Asset"
        ? buildAssignedAssetPreviewPayload(found.report)
        : found.reportType === "LotListing"
          ? buildAssignedLotListingPreviewPayload(found.report)
          : buildAssignedRealEstatePreviewPayload(found.report);

    return res.status(200).json({
      message: "Assigned preview data fetched successfully",
      data,
    });
  } catch (e: any) {
    if (e?.statusCode === 409) return res.status(409).json({ code: e.code, message: e.message });
    console.error("getAssignedAssetApprovalPreview error", e);
    return res.status(500).json({ message: "Failed to fetch assigned preview" });
  }
};

export const getAssignedApprovalPreview = getAssignedAssetApprovalPreview;

export const updateAssignedAssetApprovalPreview = async (req: any, res: Response) => {
  try {
    const userId = String(req.userId || "");
    const id = String(req.params.id || "");
    const { preview_data } = req.body || {};
    if (!preview_data) return res.status(400).json({ message: "preview_data is required" });

    const found = await findAssignedEditableApprovalReport(id, userId);
    if (!found) return res.status(404).json({ message: "Assigned report not found" });
    let report = found.report;
    const reportGenerationActive =
      (report as any).files_generating ||
      (report as any).files_regenerating ||
      (found.reportType === "LotListing" &&
        isLotListingArtifactPublicationLive(report));
    if (reportGenerationActive) {
      return res.status(found.reportType === "LotListing" ? 409 : 400).json({
        ...(found.reportType === "LotListing"
          ? { code: "LOT_LISTING_GENERATION_IN_PROGRESS" }
          : {}),
        message: "This report is already generating files and cannot be edited right now.",
      });
    }

    const previousPreviewData = clonePlain(report.preview_data || {});
    const normalized =
      found.reportType === "Asset"
        ? normalizeAssignedAssetPreviewData(preview_data, previousPreviewData)
        : found.reportType === "LotListing"
          ? normalizeAssignedLotListingPreviewData(preview_data, previousPreviewData)
          : normalizeAssignedRealEstatePreviewData(preview_data);
    if (normalized.message) return res.status(400).json({ message: normalized.message });

    if (found.reportType === "Asset") {
      report.preview_data = normalized.data;
      report.markModified("preview_data");
      await saveAssetReportWithProtectedPreviewData({
        report,
        previousPreviewData,
      });
    } else if (found.reportType === "LotListing") {
      const persistence = buildLotListingPreviewPersistence(normalized.data, report);
      report = await saveAssignedLotListingPreviewCas({
        report,
        approverId: userId,
        set: persistence.set,
        unset: persistence.unset,
      });
    } else {
      report.preview_data = normalized.data;
      report.markModified("preview_data");
      await report.save();
    }

    return res.status(200).json({
      message: "Assigned asset preview data updated successfully",
      data: report.preview_data,
      imageUrls: (report as any).imageUrls || [],
      image_count: Array.isArray((report as any).imageUrls)
        ? (report as any).imageUrls.length
        : 0,
      files_regeneration_queued: false,
    });
  } catch (e: any) {
    console.error("updateAssignedAssetApprovalPreview error", e);
    return sendAssignedPreviewMutationError(
      res,
      e,
      "Failed to update assigned preview"
    );
  }
};

export const updateAssignedApprovalPreview = updateAssignedAssetApprovalPreview;

export const resubmitAssignedAssetApprovalPreview = async (req: any, res: Response) => {
  try {
    const userId = String(req.userId || "");
    const id = String(req.params.id || "");
    const found = await findAssignedEditableApprovalReport(id, userId);
    if (!found) return res.status(404).json({ message: "Assigned report not found" });
    let report = found.report;
    if (
      found.reportType === "RealEstate" &&
      ((report as any).files_generating || (report as any).files_regenerating)
    ) {
      return res.status(400).json({
        message: "This report is already generating files and cannot be resubmitted right now.",
      });
    }

    const previousPreviewData = clonePlain(report.preview_data || {});
    const normalized =
      found.reportType === "Asset"
        ? normalizeAssignedAssetPreviewData(req.body?.preview_data || previousPreviewData, previousPreviewData)
        : found.reportType === "LotListing"
          ? normalizeAssignedLotListingPreviewData(
              req.body?.preview_data || previousPreviewData,
              previousPreviewData
            )
          : normalizeAssignedRealEstatePreviewData(req.body?.preview_data || previousPreviewData);
    if (normalized.message) return res.status(400).json({ message: normalized.message });

    if (
      found.reportType === "Asset" &&
      assignedAssetGenerationActive(report)
    ) {
      const hasIncomingPreview = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "preview_data"
      );
      if (
        !hasIncomingPreview ||
        matchesAssetGenerationSnapshot(report, normalized.data)
      ) {
        try {
          await ensureActiveAssetPreviewFilesHandoff(report);
        } catch (error: any) {
          return res.status(Number(error?.statusCode) || 503).json({
            code: error?.code || "ASSET_QUEUE_HANDOFF_PENDING",
            message:
              error?.message ||
              "The assigned Asset report is saved, but its worker handoff is still pending. Retry this request.",
          });
        }
        return res.status(202).json({
          message: "Assigned Asset files are already being generated.",
          data: {
            reportId: report._id,
            status: report.status,
            files_generating: true,
            files_regenerating: Boolean((report as any).files_regenerating),
            preview_data: report.preview_data,
            preview_files: (report as any).preview_files,
            reportType: found.reportType,
            job_id: (report as any).job_id,
          },
        });
      }
      return res.status(409).json({
        code: "ASSET_PREVIEW_GENERATION_IN_PROGRESS",
        message:
          "This assigned Asset report is already generating files. Wait for it to finish before saving different edits.",
      });
    }

    if (
      found.reportType === "LotListing" &&
      assignedLotListingGenerationActive(report)
    ) {
      const hasIncomingPreview = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "preview_data"
      );
      if (
        !hasIncomingPreview ||
        matchesLotListingGenerationSnapshot(report, normalized.data)
      ) {
        try {
          await ensureAssignedLotListingGenerationHandoff(report);
        } catch (error: any) {
          return res.status(Number(error?.statusCode) || 503).json({
            code: error?.code || "LOT_LISTING_QUEUE_HANDOFF_PENDING",
            message:
              error?.message ||
              "The assigned Lot Listing is saved, but its worker handoff is still pending. Retry this request.",
          });
        }
        return res.status(202).json({
          message: "Assigned Lot Listing files are already being generated.",
          data: {
            reportId: report._id,
            status: report.status,
            files_generating: true,
            files_regenerating: true,
            preview_data: report.preview_data,
            preview_files: (report as any).preview_files,
            reportType: found.reportType,
            job_id: (report as any).job_id,
          },
        });
      }
      return res.status(409).json({
        code: "LOT_LISTING_GENERATION_IN_PROGRESS",
        message:
          "This assigned Lot Listing is already generating files. Wait for it to finish before saving different edits.",
      });
    }
    const assetGenerationToken =
      found.reportType === "Asset"
        ? createAssetPreviewFilesGenerationToken()
        : undefined;
    const assignedAssetQueueBaseOptions = assetGenerationToken
      ? {
          previewDataSnapshot: clonePlain(normalized.data),
          approveAfterGeneration: true,
          targetStatus: "approved" as const,
          jobId: assetGenerationToken,
        }
      : undefined;
    const assignedAssetOutbox =
      assignedAssetQueueBaseOptions && shouldUseMongoReportQueue()
        ? buildAssetPreviewFilesJobOutbox(
            String(report._id),
            assignedAssetQueueBaseOptions
          )
        : undefined;
    const assignedAssetQueueOptions = assignedAssetQueueBaseOptions
      ? {
          ...assignedAssetQueueBaseOptions,
          reportJobOutboxToken: assignedAssetOutbox?.token,
        }
      : undefined;
    let assignedLotListingQueueInput:
      | Parameters<typeof regenerateLotListingFiles>[0]
      | undefined;
    let assignedLotListingOutbox: ReportJobOutbox | undefined;
    if (found.reportType === "LotListing") {
      const generationToken = new mongoose.Types.ObjectId().toHexString();
      const queuedAt = new Date();
      const persistence = buildLotListingPreviewPersistence(normalized.data, report);
      const assignedUser = (report as any).user;
      assignedLotListingQueueInput = {
        listingId: String(report._id),
        user: {
          id: String(assignedUser?._id || assignedUser || ""),
          email: String(assignedUser?.email || ""),
          name: assignedUser?.name || assignedUser?.username || undefined,
        },
        generationToken,
        previewDataSnapshot: clonePlain(persistence.previewData),
      };
      assignedLotListingOutbox = shouldUseMongoReportQueue()
        ? buildLotListingFilesJobOutbox(
            assignedLotListingQueueInput,
            "approved"
          )
        : undefined;
      assignedLotListingQueueInput.reportJobOutboxToken =
        assignedLotListingOutbox?.token;
      report = await saveAssignedLotListingPreviewCas({
        report,
        approverId: userId,
        set: {
          ...persistence.set,
          status: "processing",
          files_generating: true,
          files_regenerating: true,
          job_status: "queued",
          job_id: generationToken,
          queued_at: queuedAt,
          preview_submitted_at: queuedAt,
          approval_requested_at:
            (report as any).approval_requested_at || queuedAt,
          generation_target_status: "approved",
          ...(assignedLotListingOutbox
            ? { report_job_outbox: assignedLotListingOutbox }
            : {}),
          generation_progress: {
            stage: "generating_files",
            progressPercent: 1,
            message: "Queued to regenerate and automatically release files",
            previousStatus: "pending_approval",
            previewFingerprint: lotListingPreviewFingerprint(normalized.data),
            updatedAt: queuedAt,
          },
        },
        unset: {
          ...persistence.unset,
          job_execution_token: 1,
          job_error: 1,
          error_message: 1,
        },
      });
    } else {
      report.preview_data = normalized.data;
      report.markModified("preview_data");
      report.status = "pending_approval" as any;
      (report as any).files_generating = true;
      (report as any).files_regenerating = true;
      (report as any).job_status = "queued";
      (report as any).job_error = undefined;
      (report as any).queued_at = new Date();
      (report as any).preview_submitted_at = new Date();
      if (!(report as any).approval_requested_at) {
        (report as any).approval_requested_at = new Date();
      }
    }
    if (assetGenerationToken) {
      (report as any).job_id = assetGenerationToken;
      (report as any).job_execution_token = undefined;
      (report as any).generation_target_status = "approved";
      (report as any).generation_progress = {
        stage: "generating_files",
        progressPercent: 1,
        message: "Queued to regenerate files for approval",
        previousStatus: "pending_approval",
        previewFingerprint: assetPreviewFingerprint(normalized.data),
        updatedAt: new Date(),
      };
      (report as any).report_job_outbox = assignedAssetOutbox;
    }
    if (found.reportType === "Asset") {
      await saveAssetReportWithProtectedPreviewData({
        report,
        previousPreviewData,
      });
    } else if (found.reportType !== "LotListing") {
      await report.save();
    }

    if (found.reportType === "Asset") {
      try {
        await queuePreviewFilesJob(
          String(report._id),
          assignedAssetQueueOptions!
        );
      } catch (queueError) {
        if (assignedAssetOutbox) {
          console.error(
            "Assigned Asset durable queue handoff is pending:",
            queueError
          );
        } else {
          const reconciliation = await reconcileAssetPreviewFilesQueueFailure({
            reportId: String(report._id),
            generationToken: String(assetGenerationToken),
            error: queueError,
            fallbackStatus: "pending_approval",
          });
          if (!reconciliation.queued) throw queueError;
        }
      }
    } else if (found.reportType === "LotListing") {
      const generationToken = String((report as any).job_id || "");
      try {
        await regenerateLotListingFiles(assignedLotListingQueueInput!);
      } catch (queueError) {
        if (assignedLotListingOutbox) {
          console.error(
            "Assigned Lot Listing durable queue handoff is pending:",
            queueError
          );
        } else {
        const queued = await reconcileAssignedLotListingQueueFailure({
          report,
          generationToken,
          error: queueError,
        });
        if (!queued) throw queueError;
        }
      }
    } else {
      queueRealEstateFilesJob(String(report._id), {
        approveAfterGeneration: true,
      });
    }

    return res.status(202).json({
      message:
        found.reportType === "LotListing"
          ? "Assigned lot listing submitted. Files will be approved and released automatically after generation succeeds."
          : "Assigned report submitted. Files are being regenerated and the report will approve after generation succeeds.",
      data: {
        reportId: report._id,
        status: report.status,
        files_generating: true,
        files_regenerating: true,
        preview_data: report.preview_data,
        preview_files: (report as any).preview_files,
        reportType: found.reportType,
      },
    });
  } catch (e: any) {
    console.error("resubmitAssignedAssetApprovalPreview error", e);
    return sendAssignedPreviewMutationError(
      res,
      e,
      "Failed to submit assigned preview"
    );
  }
};

export const resubmitAssignedApprovalPreview = resubmitAssignedAssetApprovalPreview;

export const uploadAssignedAssetApprovalPreviewLotImages = async (req: any, res: Response) => {
  const uploadedFiles = collectPreviewImageUploadFiles(req.files);
  try {
    const userId = String(req.userId || "");
    const id = String(req.params.id || "");
    const lotKey = String(req.params.lotKey || "");
    const incomingPreviewData = parseMultipartPreviewData(req.body?.preview_data);

    const found = await findAssignedEditableApprovalReport(id, userId);
    if (!found || found.reportType === "RealEstate") {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(404).json({ message: "Assigned report not found" });
    }
    let report = found.report;

    if (
      (report as any).files_generating ||
      (report as any).files_regenerating ||
      (found.reportType === "LotListing" &&
        isLotListingArtifactPublicationLive(report))
    ) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(found.reportType === "LotListing" ? 409 : 400).json({
        ...(found.reportType === "LotListing"
          ? { code: "LOT_LISTING_GENERATION_IN_PROGRESS" }
          : {}),
        message: "This report is already generating files and cannot be edited right now.",
      });
    }

    const previousPreviewData = clonePlain(report.preview_data || {});
    const candidatePreviewData = incomingPreviewData || previousPreviewData;
    if (!candidatePreviewData || typeof candidatePreviewData !== "object") {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(400).json({ message: "Preview data is missing" });
    }

    const normalized =
      found.reportType === "LotListing"
        ? normalizeAssignedLotListingPreviewData(
            candidatePreviewData,
            previousPreviewData
          )
        : normalizeAssignedAssetPreviewData(
            candidatePreviewData,
            previousPreviewData
          );
    if (normalized.message) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(400).json({ message: normalized.message });
    }
    if (found.reportType === "Asset") {
      const existingPhotoLimitMessage = getPreviewLotPhotoLimitMessage(
        normalized.data
      );
      if (existingPhotoLimitMessage) {
        await cleanupMulterFiles(uploadedFiles);
        return res.status(400).json({ message: existingPhotoLimitMessage });
      }
    }

    const appendResult = await appendImagesToPreviewLot({
      kind: found.reportType === "LotListing" ? "lot-listing" : "asset",
      previewData: normalized.data,
      rootImageUrls: (report as any).imageUrls,
      reportId: String(report._id),
      lotKey,
      files: uploadedFiles,
      watermarkImages: resolvePhotoWatermark(
        normalized.data?.watermark_images,
        (report as any).watermark_images
      ),
    });

    const nextPreviewData = preserveCrDisclaimers(
      normalizePreviewDataAuctioneerSpecs(
        normalizeReviewedPreviewLotsForBusinessRules(appendResult.previewData, {
          preserveDescription: true,
        })
      ),
      previousPreviewData
    );
    const savedPreviewData =
      found.reportType === "Asset"
        ? preserveAssetProposalValuationPreviewState(
            nextPreviewData,
            previousPreviewData
          )
        : nextPreviewData;
    // The complete candidate was checked above and the append helper validates
    // the selected Asset lot before its first R2 write. Later normalization
    // does not add photo references.

    const hasPreviewChanges =
      appendResult.added.length > 0 ||
      stableLotListingPreviewJson(previousPreviewData) !==
        stableLotListingPreviewJson(savedPreviewData);
    if (hasPreviewChanges) {
      if (found.reportType === "Asset") {
        report.preview_data = savedPreviewData;
        (report as any).imageUrls = appendResult.imageUrls;
        report.markModified("preview_data");
        report.markModified("imageUrls");
        await saveAssetReportWithProtectedPreviewData({
          report,
          previousPreviewData,
        });
      } else {
        const persistence = buildLotListingPreviewPersistence(
          savedPreviewData,
          report
        );
        report = await saveAssignedLotListingPreviewCas({
          report,
          approverId: userId,
          set: {
            ...persistence.set,
            imageUrls: appendResult.imageUrls,
          },
          unset: persistence.unset,
        });
      }
    }

    return res.status(200).json({
      message:
        !hasPreviewChanges && appendResult.duplicatesSkipped > 0
          ? "These images are already saved."
          : "Images uploaded.",
      data: {
        preview_data: report.preview_data,
        preview_files: (report as any).preview_files,
        imageUrls: (report as any).imageUrls || [],
        image_count: Array.isArray((report as any).imageUrls) ? (report as any).imageUrls.length : 0,
        added: appendResult.added,
        duplicatesSkipped: appendResult.duplicatesSkipped,
        lotIndex: appendResult.lotIndex,
        files_generating: Boolean((report as any).files_generating),
        files_regenerating: Boolean((report as any).files_regenerating),
      },
      files_regeneration_queued: false,
    });
  } catch (error: any) {
    await cleanupMulterFiles(uploadedFiles);
    console.error("uploadAssignedAssetApprovalPreviewLotImages error", error);
    return sendAssignedPreviewMutationError(
      res,
      error,
      "Error uploading preview lot images"
    );
  }
};

export const refreshAssignedAssetApprovalPreviewSpecPdf = async (req: any, res: Response) => {
  try {
    const userId = String(req.userId || "");
    const id = String(req.params.id || "");
    const found = await findAssignedEditableApprovalReport(id, userId);
    if (!found || found.reportType === "RealEstate") {
      return res.status(404).json({ message: "Assigned report not found" });
    }
    let report = found.report;

    if (!report.preview_data) {
      return res.status(400).json({ message: "Preview data is missing" });
    }

    if (
      (report as any).files_generating ||
      (report as any).files_regenerating ||
      (found.reportType === "LotListing" &&
        isLotListingArtifactPublicationLive(report))
    ) {
      return res.status(409).json({
        code: "CR_ARTIFACT_PUBLISH_IN_PROGRESS",
        message: "This report is already generating files and cannot refresh the CR right now.",
      });
    }

    const previousPreviewData = clonePlain(report.preview_data || {});
    const normalized =
      found.reportType === "LotListing"
        ? normalizeAssignedLotListingPreviewData(
            report.preview_data,
            previousPreviewData
          )
        : normalizeAssignedAssetPreviewData(
            report.preview_data,
            previousPreviewData
          );
    if (normalized.message) return res.status(400).json({ message: normalized.message });
    report.preview_data = normalized.data;
    report.markModified("preview_data");
    if (found.reportType === "Asset") {
      await saveAssetReportWithProtectedPreviewData({
        report,
        previousPreviewData,
      });
    } else {
      const persistence = buildLotListingPreviewPersistence(
        normalized.data,
        report
      );
      report = await saveAssignedLotListingPreviewCas({
        report,
        approverId: userId,
        set: persistence.set,
        unset: persistence.unset,
      });
    }

    const { specPdf, crDocx } =
      found.reportType === "LotListing"
        ? await generateAndStoreLotListingCrArtifacts(report)
        : await generateAndStoreAssetCrArtifacts(report);
    return res.status(200).json({
      message: "CR generated",
      data: {
        spec_pdf: specPdf,
        cr_docx: crDocx,
        preview_files: (report as any).preview_files,
        preview_data: report.preview_data,
        imageUrls: (report as any).imageUrls || [],
        image_count: Array.isArray((report as any).imageUrls)
          ? (report as any).imageUrls.length
          : 0,
      },
    });
  } catch (error: any) {
    console.error("refreshAssignedAssetApprovalPreviewSpecPdf error", error);
    return sendAssignedPreviewMutationError(res, error, "Error generating CR");
  }
};

// Approve a report and notify the owner
export const approveReport = async (req: any, res: Response) => {
  try {
    const { id } = req.params;
    const adminUser = req.user; // from adminProtect
    
    // Check if it's an AssetReport first
    let assetReport: any = await AssetReport.findOne({
      _id: id,
      is_draft_preview: { $ne: true },
    }).populate("user", "email username");
    if (assetReport) {
      // New workflow: AssetReport with preview
      if (!canProcessAssignedApproval(assetReport, adminUser)) {
        return res.status(403).json({ message: assignedApprovalDeniedMessage() });
      }
      if (assetReport.status === "approved") {
        return res.status(200).json({
          message: "AssetReport was already approved",
          already_processed: true,
        });
      }
      if (assetReport.status !== 'pending_approval') {
        return res.status(409).json({
          code: "REPORT_APPROVAL_DECISION_CONFLICT",
          message: `AssetReport was already changed to ${assetReport.status}`,
        });
      }
      assertReportFilesReadyForWorkflow("asset", assetReport);
      
      await assignReleaseManager(assetReport, {
        userId: (assetReport as any).user?._id || (assetReport as any).user,
        forceManual: Boolean((assetReport as any).auctioneerWorkItem),
      });
      const decision = await claimReportApprovalDecision({
        model: AssetReport,
        report: assetReport,
        pendingStatus: "pending_approval",
        targetStatus: "approved",
        set: {
          approval_processed_at: new Date(),
          ...releaseFieldsForApprovalDecision(assetReport),
        },
        unset: { decline_reason: 1 },
        populate: "user",
      });
      assetReport = decision.report;
      if (!decision.claimed) {
        return res.status(200).json({
          message: "AssetReport was already approved",
          already_processed: true,
        });
      }
      await sendAssignedReleaseEmail(assetReport, {
        reportType: "Asset",
        creatorUserId: (assetReport as any).user?._id || (assetReport as any).user,
        title: (assetReport as any).preview_data?.client_name || (assetReport as any).contract_no,
        summary: (assetReport as any).contract_no || (assetReport as any).preview_data?.contract_no,
      });
      if ((assetReport as any).isModified?.("release_assignment_email_sent_at")) {
        await assetReport.save().catch((markerError: unknown) => {
          console.error("[approveReport] Asset release email marker save error:", markerError);
        });
      }
      
      // NO LONGER NEEDED: Use preview_files URLs directly instead of creating local copies
      // const { queueDocxGenerationJob } = await import("../jobs/assetReportJob.js");
      // queueDocxGenerationJob(String(assetReport._id));
      
      // Send approval email
      const to = (assetReport as any).user?.email as string | undefined;
      if (to) {
        try {
          if ((assetReport as any).release_status === "pending_release") {
            const webUrl = process.env.WEB_APP_URL || "http://localhost:3000";
            await sendEmail(
              to,
              "Asset Report Approved - Awaiting Release",
              `<div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#111827;">
                <h2>Report approved</h2>
                <p>Your asset report has been approved and is waiting for release before downloads are available.</p>
                <p><a href="${webUrl}/reports" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;">View Reports</a></p>
              </div>`
            );
          } else {
            const { sendReportApprovedEmail } = await import("../service/assetEmailService.js");
            await sendReportApprovedEmail(
              to,
              (assetReport as any).user?.username || "User",
              String(assetReport._id)
            );
          }
        } catch (emailError) {
          console.error("[approveReport] Asset approval email error:", emailError);
        }
      }

      try {
        await notifyUser({
          userId: String((assetReport as any).user?._id || (assetReport as any).user || ""),
          category: "report",
          type: "report_approved",
          title: "Report Approved",
          body: (assetReport as any).release_status === "pending_release"
            ? "Your asset report has been approved and is waiting for release."
            : "Your asset report has been approved and is ready for download.",
          data: {
            type: "report_approved",
            reportId: String(assetReport._id),
            reportType: "Asset",
          },
        });
      } catch (pushErr) {
        console.error("[approveReport] Push notification error:", pushErr);
      }
      
      return res.status(200).json({ message: "AssetReport approved successfully" });
    }
    
    // Check if it's a RealEstateReport
    let realEstateReport: any = await RealEstateReport.findById(id).populate("user", "email username");
    if (realEstateReport) {
      // RealEstateReport with preview
      if (!canProcessAssignedApproval(realEstateReport, adminUser)) {
        return res.status(403).json({ message: assignedApprovalDeniedMessage() });
      }
      if ((realEstateReport as any).status === "approved") {
        return res.status(200).json({
          message: "RealEstateReport was already approved",
          already_processed: true,
        });
      }
      if ((realEstateReport as any).status !== 'pending_approval') {
        return res.status(409).json({
          code: "REPORT_APPROVAL_DECISION_CONFLICT",
          message: `RealEstateReport was already changed to ${(realEstateReport as any).status}`,
        });
      }
      assertReportFilesReadyForWorkflow("realEstate", realEstateReport);
      
      markReportAutoReleased(realEstateReport, { releasedBy: adminUser?._id });
      const decision = await claimReportApprovalDecision({
        model: RealEstateReport,
        report: realEstateReport,
        pendingStatus: "pending_approval",
        targetStatus: "approved",
        set: {
          approval_processed_at: new Date(),
          ...releaseFieldsForApprovalDecision(realEstateReport),
        },
        unset: { decline_reason: 1 },
        populate: "user",
      });
      realEstateReport = decision.report;
      if (!decision.claimed) {
        return res.status(200).json({
          message: "RealEstateReport was already approved",
          already_processed: true,
        });
      }
      // Send approval email
      const to = (realEstateReport as any).user?.email as string | undefined;
      if (to) {
        const webUrl = process.env.WEB_APP_URL || "http://localhost:3000";
        const subject = "Your Asset Insight Real Estate Report was approved";
        const address = (realEstateReport as any).property_details?.address || 'Real Estate Report';
        const html = `
          <div style="font-family: Inter, Arial, sans-serif;">
            <h2 style="color:#111827;">Real Estate Report Approved ✅</h2>
            <p>Hi ${(realEstateReport as any).user?.username || "there"},</p>
            <p>Your real estate report has been approved and is now ready for download.</p>
            <ul>
              <li><strong>Property:</strong> ${address}</li>
              <li><strong>Created:</strong> ${new Date((realEstateReport as any).createdAt).toLocaleString()}</li>
            </ul>
            <p><a href="${webUrl}/reports" style="display:inline-block;padding:10px 16px;background:#10b981;color:#fff;border-radius:10px;text-decoration:none;">Go to Reports</a></p>
          </div>
        `;
        try {
          await sendEmail(to, subject, html);
        } catch (err) {
          console.error("Failed to send real estate approval email", err);
        }
      }
      
      try {
        await notifyUser({
          userId: String((realEstateReport as any).user?._id || (realEstateReport as any).user || ""),
          category: "report",
          type: "report_approved",
          title: "Report Approved",
          body: "Your real estate report has been approved and is ready for download.",
          data: {
            type: "report_approved",
            reportId: String(realEstateReport._id),
            reportType: "RealEstate",
          },
        });
      } catch (pushErr) {
        console.error("[approveReport] RE Push notification error:", pushErr);
      }

      return res.status(200).json({ message: "RealEstateReport approved successfully" });
    }

    // Check if it's a LotListing
    let lotListing: any = await LotListing.findOne({
      _id: id,
      is_draft_preview: { $ne: true },
    }).populate("user", "email username");
    if (lotListing) {
      if (!canProcessAssignedApproval(lotListing, adminUser)) {
        return res.status(403).json({ message: assignedApprovalDeniedMessage() });
      }
      if (lotListing.status === "approved") {
        return res.status(200).json({
          message: "Lot Listing was already approved successfully",
          already_processed: true,
        });
      }
      if (lotListing.status !== "pending_approval") {
        return res.status(409).json({
          code: "REPORT_APPROVAL_DECISION_CONFLICT",
          message: `Lot Listing was already changed to ${lotListing.status}`,
        });
      }
      assertReportFilesReadyForWorkflow("lotListing", lotListing);

      await assignReleaseManager(lotListing, {
        userId: (lotListing as any).user?._id || (lotListing as any).user,
        forceManual: Boolean((lotListing as any).auctioneerWorkItem),
      });
      const decision = await claimReportApprovalDecision({
        model: LotListing,
        report: lotListing,
        pendingStatus: "pending_approval",
        targetStatus: "approved",
        set: {
          files: clonePlain((lotListing as any).preview_files || {}),
          approval_processed_at: new Date(),
          ...releaseFieldsForApprovalDecision(lotListing),
        },
        unset: { decline_reason: 1 },
        populate: "user",
      });
      lotListing = decision.report;
      if (!decision.claimed) {
        return res.status(200).json({
          message: "Lot Listing was already approved successfully",
          already_processed: true,
        });
      }
      const releaseEmailSent = await sendAssignedReleaseEmail(lotListing, {
        reportType: "Lot Listing",
        creatorUserId: (lotListing as any).user?._id || (lotListing as any).user,
        title: (lotListing as any).preview_data?.contract_no || (lotListing as any).contract_no,
        summary: (lotListing as any).preview_data?.location || (lotListing as any).location,
      });
      if (releaseEmailSent) {
        await lotListing.save().catch((markerError: unknown) => {
          console.error("[approveReport] Lot Listing release email marker save error:", markerError);
        });
      }

      const owner = (lotListing as any).user;
      if (owner?.email) {
        const awaitingRelease = (lotListing as any).release_status === "pending_release";
        await sendEmail(
          owner.email,
          "Lot Listing Approved",
          `<div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#111827;">
            <h2>Lot listing approved</h2>
            <p>Your lot listing has been approved${
              awaitingRelease
                ? " and is waiting for release before downloads are available."
                : " and is ready to download."
            }</p>
          </div>`
        ).catch((emailError) => {
          console.error("[approveReport] Lot Listing approval email error:", emailError);
        });
      }
      await notifyUser({
        userId: String(owner?._id || owner || ""),
        category: "report",
        type: "lot_listing_approved",
        title: "Lot Listing Approved",
        body: (lotListing as any).release_status === "pending_release"
          ? "Your lot listing has been approved and is waiting for release."
          : "Your lot listing has been approved and is ready to download.",
        data: {
          type: "lot_listing_approved",
          reportId: String(lotListing._id),
          reportType: "LotListing",
        },
      }).catch((pushErr) => {
        console.error("[approveReport] Lot Listing push notification error:", pushErr);
      });

      return res.status(200).json({ message: "Lot Listing approved successfully" });
    }
    
    // Old workflow: PdfReport
    let report: any = await PdfReport.findById(id).populate("user", "email username");
    if (!report) return res.status(404).json({ message: "Report not found" });
    if (!canProcessAssignedApproval(report, adminUser)) {
      return res.status(403).json({ message: assignedApprovalDeniedMessage() });
    }

    // Approve ALL sibling outputs for the same report (one-click approval)
    const now = new Date();
    const salvageParent = await assertCurrentSalvagePdfArtifact(report);
    if (salvageParent) await assertLegacyPdfReportGroupFilesReady(report);
    const filter = pdfReportSiblingFilter(report);
    const siblings = await PdfReport.find(filter)
      .select("approvalStatus approval_assigned_to")
      .lean();
    if (siblings.some((sibling: any) => !canProcessAssignedApproval(sibling, adminUser))) {
      return res.status(403).json({ message: assignedApprovalDeniedMessage() });
    }
    if (siblings.some((sibling: any) => sibling.approvalStatus === "rejected")) {
      return res.status(409).json({
        code: "REPORT_APPROVAL_DECISION_CONFLICT",
        message: "This report group was already rejected.",
      });
    }
    const alreadyApproved = siblings.some(
      (sibling: any) => sibling.approvalStatus === "approved"
    );
    if (alreadyApproved) {
      const approvedAnchor = await PdfReport.findOne({
        ...filter,
        approvalStatus: "approved",
      }).lean();
      await PdfReport.updateMany(
        { ...filter, approvalStatus: "pending" },
        {
          $set: {
            approvalStatus: "approved",
            approvalNote: approvedAnchor?.approvalNote || "",
            reviewedBy: approvedAnchor?.reviewedBy ?? null,
            reviewedAt: approvedAnchor?.reviewedAt ?? null,
            ...(approvedAnchor?.salvage_review_acknowledgement
              ? { salvage_review_acknowledgement: approvedAnchor.salvage_review_acknowledgement }
              : {}),
            ...(approvedAnchor
              ? releaseFieldsForApprovalDecision(approvedAnchor)
              : {}),
          },
        }
      );
      return res.status(200).json({
        message: "All outputs for this report were already approved",
        already_processed: true,
      });
    }
    await assertLegacyPdfReportGroupFilesReady(report);
    const decisionAnchor = await PdfReport.findOne(filter)
      .sort({ _id: 1 })
      .populate("user", "email username");
    if (!decisionAnchor) {
      return res.status(404).json({ message: "Report not found" });
    }
    if (approvalAutomaticallyReleases(decisionAnchor.reportType)) {
      markReportAutoReleased(decisionAnchor, { releasedBy: adminUser?._id });
    } else {
      await assignReleaseManager(decisionAnchor, {
        userId: (decisionAnchor as any).user?._id || (decisionAnchor as any).user,
      });
    }
    const releaseUpdate = releaseFieldsForApprovalDecision(decisionAnchor);
    const acknowledgement = salvageApprovalAcknowledgement(
      salvageParent, req.body?.salvageReviewAcknowledgement, adminUser?._id, now,
    );
    const update = {
      approvalNote: "",
      reviewedBy: adminUser?._id,
      reviewedAt: now,
      ...(acknowledgement ? { salvage_review_acknowledgement: acknowledgement } : {}),
      ...releaseUpdate,
    };
    const decision = await claimReportApprovalDecision({
      model: PdfReport,
      report: decisionAnchor,
      statusField: "approvalStatus",
      pendingStatus: "pending",
      targetStatus: "approved",
      set: update,
      populate: "user",
    });
    report = decision.report;
    const persistedReleaseUpdate = releaseFieldsForApprovalDecision(report);
    await PdfReport.updateMany(
      {
        ...filter,
        _id: { $ne: report._id },
        approvalStatus: "pending",
      },
      {
        $set: {
          approvalStatus: "approved",
          // A concurrent loser receives the winner's persisted anchor. Fan out
          // that decision, never this request's reviewer/note/acknowledgement.
          approvalNote: report.approvalNote || "",
          reviewedBy: report.reviewedBy ?? null,
          reviewedAt: report.reviewedAt ?? null,
          salvage_review_acknowledgement: report.salvage_review_acknowledgement ?? null,
          ...persistedReleaseUpdate,
        },
      }
    );
    if (!decision.claimed) {
      return res.status(200).json({
        message: "All outputs for this report were already approved",
        already_processed: true,
      });
    }
    await sendAssignedReleaseEmail(report, {
      reportType: (report as any).reportType || "Report",
      creatorUserId: (report as any).user?._id || (report as any).user,
      title: (report as any).address || (report as any).filename,
      summary: (report as any).fairMarketValue,
    });
    if ((report as any).release_assignment_email_sent_at) {
      await PdfReport.updateMany(filter, {
        $set: { release_assignment_email_sent_at: (report as any).release_assignment_email_sent_at },
      }).catch((markerError: unknown) => {
        console.error("[approveReport] Legacy release email marker save error:", markerError);
      });
    }

    const to = (report as any).user?.email as string | undefined;
    if (to) {
      const webUrl = process.env.WEB_APP_URL || "http://localhost:3000";
      const subject = "Your Asset Insight report was approved";
      const awaitingRelease = (report as any).release_status === "pending_release";
      const html = `
        <div style="font-family: Inter, Arial, sans-serif;">
          <h2 style="color:#111827;">Report Approved ✅</h2>
          <p>Hi ${(report as any).user?.username || "there"},</p>
          <p>Your report outputs (PDF, DOCX, Excel${report.fileType === 'images' ? '' : ', and Images ZIP' }) have been approved by ${adminUser?.username || adminUser?.email}.</p>
          ${awaitingRelease ? "<p>Downloads will be available after the release manager releases the report.</p>" : "<p>You can now download your report from your dashboard.</p>"}
          <ul>
            <li><strong>Type:</strong> ${report.reportType}</li>
            <li><strong>Address:</strong> ${report.address}</li>
            <li><strong>FMV:</strong> ${report.fairMarketValue}</li>
            <li><strong>Created:</strong> ${new Date(report.createdAt as any).toLocaleString()}</li>
          </ul>
          <p><a href="${webUrl}/reports" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:10px;text-decoration:none;">Go to Reports</a></p>
          <hr/>
          <p style="color:#6b7280;font-size:12px;">Approved by: ${adminUser?.username || "Admin"} (${adminUser?.email})</p>
        </div>
      `;
      try {
        await sendEmail(to, subject, html);
      } catch (err) {
        console.error("Failed to send approval email", err);
      }
    }

    return res.status(200).json({ message: "All outputs for this report have been approved" });
  } catch (e: any) {
    if (Number(e?.statusCode) === 409) {
      return res.status(409).json({
        code: e?.code,
        message: e?.message || "Report files are not ready for approval",
        ...(Array.isArray(e?.requiredLimitationCodes)
          ? { requiredLimitationCodes: e.requiredLimitationCodes } : {}),
      });
    }
    console.error("approveReport error", e);
    return res.status(500).json({ message: "Failed to approve report" });
  }
};

// Reject a report with a note and notify the owner
export const rejectReport = async (req: any, res: Response) => {
  try {
    const { id } = req.params;
    const { note } = req.body || {};
    if (!note || typeof note !== "string" || !note.trim()) {
      return res.status(400).json({ message: "Rejection note is required" });
    }
    const adminUser = req.user; // from adminProtect
    
    // Check if it's an AssetReport first
    let assetReport: any = await AssetReport.findOne({
      _id: id,
      is_draft_preview: { $ne: true },
    }).populate("user", "email username");
    if (assetReport) {
      // New workflow: AssetReport with preview
      if (!canProcessAssignedApproval(assetReport, adminUser)) {
        return res.status(403).json({ message: assignedApprovalDeniedMessage() });
      }
      if (assetReport.status === "declined") {
        return res.status(200).json({
          message: "AssetReport was already declined",
          already_processed: true,
        });
      }
      if (assetReport.status !== 'pending_approval') {
        return res.status(409).json({
          code: "REPORT_APPROVAL_DECISION_CONFLICT",
          message: `AssetReport was already changed to ${assetReport.status}`,
        });
      }

      const decision = await claimReportApprovalDecision({
        model: AssetReport,
        report: assetReport,
        pendingStatus: "pending_approval",
        targetStatus: "declined",
        set: {
          decline_reason: note.trim(),
          approval_processed_at: new Date(),
        },
        populate: "user",
      });
      assetReport = decision.report;
      if (!decision.claimed) {
        return res.status(200).json({
          message: "AssetReport was already declined",
          already_processed: true,
        });
      }
      
      // Send decline email
      const to = (assetReport as any).user?.email as string | undefined;
      if (to) {
        const { sendReportDeclinedEmail } = await import("../service/assetEmailService.js");
        await sendReportDeclinedEmail(
          to,
          (assetReport as any).user?.username || "User",
          String(assetReport._id),
          note.trim()
        ).catch((emailError) => {
          console.error("[rejectReport] Asset rejection email error:", emailError);
        });
      }

      await notifyUser({
        userId: String((assetReport as any).user?._id || (assetReport as any).user || ""),
        category: "report",
        type: "report_declined",
        title: "Report Requires Revision",
        body: "Your asset report was declined. Review the notes and resubmit it.",
        data: {
          type: "report_declined",
          reportId: String(assetReport._id),
          reportType: "Asset",
        },
      }).catch((pushErr) => {
        console.error("[rejectReport] Asset push notification error:", pushErr);
      });
      
      return res.status(200).json({ message: "AssetReport declined" });
    }
    
    // Check if it's a RealEstateReport
    let realEstateReport: any = await RealEstateReport.findById(id).populate("user", "email username");
    if (realEstateReport) {
      // RealEstateReport with preview
      if (!canProcessAssignedApproval(realEstateReport, adminUser)) {
        return res.status(403).json({ message: assignedApprovalDeniedMessage() });
      }
      if ((realEstateReport as any).status === "declined") {
        return res.status(200).json({
          message: "RealEstateReport was already declined",
          already_processed: true,
        });
      }
      if ((realEstateReport as any).status !== 'pending_approval') {
        return res.status(409).json({
          code: "REPORT_APPROVAL_DECISION_CONFLICT",
          message: `RealEstateReport was already changed to ${(realEstateReport as any).status}`,
        });
      }

      const decision = await claimReportApprovalDecision({
        model: RealEstateReport,
        report: realEstateReport,
        pendingStatus: "pending_approval",
        targetStatus: "declined",
        set: {
          decline_reason: note.trim(),
          approval_processed_at: new Date(),
        },
        populate: "user",
      });
      realEstateReport = decision.report;
      if (!decision.claimed) {
        return res.status(200).json({
          message: "RealEstateReport was already declined",
          already_processed: true,
        });
      }
      
      // Send decline email
      const to = (realEstateReport as any).user?.email as string | undefined;
      if (to) {
        const address = (realEstateReport as any).property_details?.address || 'Real Estate Report';
        const subject = "Your Asset Insight Real Estate Report was rejected";
        const html = `
          <div style="font-family: Inter, Arial, sans-serif;">
            <h2 style="color:#111827;">Real Estate Report Rejected ❌</h2>
            <p>Hi ${(realEstateReport as any).user?.username || "there"},</p>
            <p>Your real estate report was reviewed and unfortunately it was not approved at this time.</p>
            <ul>
              <li><strong>Property:</strong> ${address}</li>
              <li><strong>Created:</strong> ${new Date((realEstateReport as any).createdAt).toLocaleString()}</li>
            </ul>
            <p><strong>Reason:</strong> ${note.trim()}</p>
            <p>Please make the necessary corrections and resubmit your report.</p>
          </div>
        `;
        try {
          await sendEmail(to, subject, html);
        } catch (err) {
          console.error("Failed to send real estate rejection email", err);
        }
      }

      await notifyUser({
        userId: String((realEstateReport as any).user?._id || (realEstateReport as any).user || ""),
        category: "report",
        type: "report_declined",
        title: "Report Requires Revision",
        body: "Your real estate report was declined. Review the notes and resubmit it.",
        data: {
          type: "report_declined",
          reportId: String(realEstateReport._id),
          reportType: "RealEstate",
        },
      }).catch((pushErr) => {
        console.error("[rejectReport] Real estate push notification error:", pushErr);
      });
      
      return res.status(200).json({ message: "RealEstateReport declined" });
    }

    // Check if it's a LotListing
    let lotListing: any = await LotListing.findOne({
      _id: id,
      is_draft_preview: { $ne: true },
    }).populate("user", "email username");
    if (lotListing) {
      if (!canProcessAssignedApproval(lotListing, adminUser)) {
        return res.status(403).json({ message: assignedApprovalDeniedMessage() });
      }
      if (lotListing.status === "declined") {
        return res.status(200).json({
          message: "Lot Listing was already declined",
          already_processed: true,
        });
      }
      if (lotListing.status !== "pending_approval") {
        return res.status(409).json({
          code: "REPORT_APPROVAL_DECISION_CONFLICT",
          message: `Lot Listing was already changed to ${lotListing.status}`,
        });
      }
      const decision = await claimReportApprovalDecision({
        model: LotListing,
        report: lotListing,
        pendingStatus: "pending_approval",
        targetStatus: "declined",
        set: {
          decline_reason: note.trim(),
          approval_processed_at: new Date(),
        },
        unset: {
          release_status: 1,
          release_assigned_to: 1,
          release_assigned_at: 1,
          release_assigned_source: 1,
          release_assignment_email_sent_at: 1,
          released_by: 1,
          released_at: 1,
        },
        populate: "user",
      });
      lotListing = decision.report;
      if (!decision.claimed) {
        return res.status(200).json({
          message: "Lot Listing was already declined",
          already_processed: true,
        });
      }

      const owner = (lotListing as any).user;
      if (owner?.email) {
        await sendEmail(
          owner.email,
          "Lot Listing Requires Revision",
          `<div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#111827;">
            <h2>Lot listing requires revision</h2>
            <p>Your lot listing was not approved.</p>
            <p><strong>Reason:</strong> ${note.trim()}</p>
          </div>`
        ).catch((emailError) => {
          console.error("[rejectReport] Lot Listing rejection email error:", emailError);
        });
      }
      await notifyUser({
        userId: String(owner?._id || owner || ""),
        category: "report",
        type: "report_declined",
        title: "Lot Listing Requires Revision",
        body: "Your lot listing was declined. Review the notes and resubmit it.",
        data: {
          type: "report_declined",
          reportId: String(lotListing._id),
          reportType: "LotListing",
        },
      }).catch((pushErr) => {
        console.error("[rejectReport] Lot Listing push notification error:", pushErr);
      });

      return res.status(200).json({ message: "Lot Listing declined" });
    }
    
    // Old workflow: PdfReport
    let report: any = await PdfReport.findById(id).populate("user", "email username");
    if (!report) return res.status(404).json({ message: "Report not found" });
    if (!canProcessAssignedApproval(report, adminUser)) {
      return res.status(403).json({ message: assignedApprovalDeniedMessage() });
    }

    // Reject ALL sibling outputs for the same report
    const now = new Date();
    if (await assertCurrentSalvagePdfArtifact(report)) await assertLegacyPdfReportGroupFilesReady(report);
    const filter = pdfReportSiblingFilter(report);
    const siblings = await PdfReport.find(filter)
      .select("approvalStatus approval_assigned_to")
      .lean();
    if (siblings.some((sibling: any) => !canProcessAssignedApproval(sibling, adminUser))) {
      return res.status(403).json({ message: assignedApprovalDeniedMessage() });
    }
    if (siblings.some((sibling: any) => sibling.approvalStatus === "approved")) {
      return res.status(409).json({
        code: "REPORT_APPROVAL_DECISION_CONFLICT",
        message: "This report group was already approved.",
      });
    }
    const alreadyRejected = siblings.some(
      (sibling: any) => sibling.approvalStatus === "rejected"
    );
    if (alreadyRejected) {
      const rejectedAnchor = await PdfReport.findOne({
        ...filter,
        approvalStatus: "rejected",
      }).lean();
      await PdfReport.updateMany(
        { ...filter, approvalStatus: "pending" },
        {
          $set: {
            approvalStatus: "rejected",
            approvalNote:
              String((rejectedAnchor as any)?.approvalNote || "").trim() ||
              note.trim(),
            reviewedBy:
              (rejectedAnchor as any)?.reviewedBy || adminUser?._id,
            reviewedAt: (rejectedAnchor as any)?.reviewedAt || now,
          },
        }
      );
      return res.status(200).json({
        message: "All outputs for this report were already rejected",
        already_processed: true,
      });
    }
    const decisionAnchor = await PdfReport.findOne(filter)
      .sort({ _id: 1 })
      .populate("user", "email username");
    if (!decisionAnchor) {
      return res.status(404).json({ message: "Report not found" });
    }
    const decision = await claimReportApprovalDecision({
      model: PdfReport,
      report: decisionAnchor,
      statusField: "approvalStatus",
      pendingStatus: "pending",
      targetStatus: "rejected",
      set: {
        approvalNote: note.trim(),
        reviewedBy: adminUser?._id,
        reviewedAt: now,
      },
      populate: "user",
    });
    report = decision.report;
    await PdfReport.updateMany(
      {
        ...filter,
        _id: { $ne: report._id },
        approvalStatus: "pending",
      },
      {
        $set: {
          approvalStatus: "rejected",
          approvalNote: report.approvalNote || note.trim(),
          reviewedBy: report.reviewedBy || adminUser?._id,
          reviewedAt: report.reviewedAt || now,
        },
      }
    );
    if (!decision.claimed) {
      return res.status(200).json({
        message: "All outputs for this report were already rejected",
        already_processed: true,
      });
    }

    const to = (report as any).user?.email as string | undefined;
    if (to) {
      const subject = "Your Asset Insight report was rejected";
      const html = `
        <div style="font-family: Inter, Arial, sans-serif;">
          <h2 style="color:#111827;">Report Rejected ❌</h2>
          <p>Hi ${(report as any).user?.username || "there"},</p>
          <p>Your report was reviewed by ${adminUser?.username || adminUser?.email} and unfortunately it was not approved at this time.</p>
          <ul>
            <li><strong>Type:</strong> ${report.reportType}</li>
            <li><strong>Address:</strong> ${report.address}</li>
            <li><strong>FMV:</strong> ${report.fairMarketValue}</li>
            <li><strong>Created:</strong> ${new Date(report.createdAt as any).toLocaleString()}</li>
          </ul>
          <p><strong>Reason:</strong> ${report.approvalNote}</p>
          <hr/>
          <p style="color:#6b7280;font-size:12px;">Reviewed by: ${adminUser?.username || "Admin"} (${adminUser?.email})</p>
        </div>
      `;
      try {
        await sendEmail(to, subject, html);
      } catch (err) {
        console.error("Failed to send rejection email", err);
      }
    }

    return res.status(200).json({ message: "All outputs for this report have been rejected" });
  } catch (e: any) {
    if (Number(e?.statusCode) === 409) {
      return res.status(409).json({
        code: e?.code,
        message:
          e?.message ||
          "The report changed while the approval decision was being saved.",
      });
    }
    console.error("rejectReport error", e);
    return res.status(500).json({ message: "Failed to reject report" });
  }
};
