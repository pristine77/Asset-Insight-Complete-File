/**
 * Administrative preview queue for incomplete and pre-submission reports.
 *
 * The controller normalizes multiple report models into one review contract and lets
 * administrators remind, transfer or delete work. Ownership changes and cleanup
 * coordinate related jobs, drafts, and artifacts, reporting warnings when ancillary
 * alignment or cleanup operations fail.
 */
import { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import PdfReport from "../models/pdfReport.model.js";
import ReportDraft from "../models/reportDraft.model.js";
import ReportJob from "../models/reportJob.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import User from "../models/user.model.js";
import ReviewAccountBoundary from "../models/reviewAccountBoundary.model.js";
import type { AdminAuthRequest } from "../middleware/admin.middleware.js";
import { getReportPreviewPayloadById } from "../service/reportPreviewService.js";
import {
  getPreviewTransferEligibility,
  hasValidLotsForPreviewTransfer,
  isFailedSubmittedPreview,
  savedLotsForPreviewTransfer,
  notifyPreviewOwnershipTransfer,
} from "../service/previewOwnershipTransferService.js";
import {
  getPreviewReminderEligibility,
  getAdminPreviewReminderDraft,
  sendReviewedAdminPreviewReminder,
} from "../service/previewReminderService.js";
import {
  resolveReportGenerationState,
  type ReportWorkflowStage,
} from "../utils/reportFileState.js";
import {
  deleteFromR2,
  isCurrentR2StorageTarget,
  resolveCurrentR2ObjectLocationFromUrl,
  resolvePersistedR2StorageTarget,
} from "../utils/r2Storage/r2Upload.js";
import { toReportDraftClient } from "../service/reportDraftService.js";
import { deleteDraftMediaObjects } from "../service/reportDraftMediaService.js";
import { deleteHiddenDraftPreview } from "../service/reportDraftPreviewService.js";
import { getReportResubmitState, resubmitSavedReportPreview } from "../service/reportRestartRecoveryService.js";
import { proposalValuationWritableRevisionCondition } from "../service/proposalValuationArtifactPublicationService.js";
import { lotListingArtifactPublicationAvailableCondition } from "../service/lotListingArtifactPublicationService.js";

const MAX_PAGE_SIZE = 100;
const MAX_ACTIVE_ROWS_PER_COLLECTION = 10_000;
const PREVIEW_STAGES = new Set<ReportWorkflowStage>([
  "preparing_preview",
  "preview_ready",
  "generating_files",
  "awaiting_approval",
  "awaiting_release",
  "error",
]);

type PreviewReportType = "Asset" | "LotListing";

type PreviewSummaryRow = {
  _id: mongoose.Types.ObjectId;
  reportType: PreviewReportType;
  user?: mongoose.Types.ObjectId | string | null;
  contractNo?: string;
  clientName?: string;
  status?: string;
  release_status?: string;
  job_status?: string;
  job_error?: string;
  error_message?: string;
  files_generating?: boolean;
  files_regenerating?: boolean;
  files_regeneration_pending?: boolean;
  excel_regenerating?: boolean;
  proposal_valuation_regeneration_claim_token?: string;
  report_job_outbox?: unknown;
  validSavedLots?: boolean;
  hasActiveJob?: boolean;
  processing_completed_at?: Date;
  preview_submitted_at?: Date;
  approval_requested_at?: Date;
  generation_target_status?: string;
  generation_progress?: Record<string, unknown>;
  preview_files?: Record<string, unknown>;
  files?: Record<string, unknown>;
  preview_transferred_from?: mongoose.Types.ObjectId | string | null;
  preview_transferred_to?: mongoose.Types.ObjectId | string | null;
  preview_transferred_by?: mongoose.Types.ObjectId | string | null;
  preview_transferred_at?: Date | null;
  preview_reminder_sent_at?: Date | null;
  preview_reminder_claimed_at?: Date | null;
  lotCount: number;
  imageCount: number;
  lotNumbers: Array<string | number>;
  thumbnailUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SafeOwner = {
  id: string;
  username: string;
  email: string;
  companyName: string;
  isBlocked: boolean;
};

function noStore(res: Response) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
}

function parsePagination(req: Request) {
  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(String(req.query.limit || "25"), 10) || 25)
  );
  return { page, limit };
}

function safeDate(value: unknown, endOfDay = false): Date | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function escapeSearch(value: unknown) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase().slice(0, 160) : "";
}

function activePreviewMatch(from: Date | null, to: Date | null) {
  const createdAt: Record<string, Date> = {};
  if (from) createdAt.$gte = from;
  if (to) createdAt.$lte = to;

  return {
    adminArchivedAt: null,
    is_draft_preview: { $ne: true },
    ...(Object.keys(createdAt).length ? { createdAt } : {}),
    $or: [
      { status: { $in: ["processing", "preview", "declined", "pending_approval", "error"] } },
      { job_status: { $in: ["queued", "processing", "error"] } },
      { files_generating: true },
      { files_regenerating: true },
      { status: "approved", release_status: "pending_release" },
    ],
  };
}

/**
 * Lists explicit user-saved draft previews. Draft records remain authoritative
 * for ownership and resumability; the hidden report id is exposed only so a
 * ready draft can reuse the normal full preview inspector.
 */
export async function getAdminDraftPreviews(req: Request, res: Response) {
  try {
    noStore(res);
    const { page, limit } = parsePagination(req);
    const search = String(req.query.search || "").trim().slice(0, 160);
    const type = String(req.query.reportType || "all");
    const status = String(req.query.previewStatus || "all");
    const creatorId = String(req.query.creatorId || "").trim();

    if (!['all', 'asset', 'lotListing'].includes(type)) {
      return res.status(400).json({ message: "Invalid draft report type." });
    }
    if (!['all', 'idle', 'queued', 'processing', 'ready', 'error'].includes(status)) {
      return res.status(400).json({ message: "Invalid draft preview status." });
    }
    if (creatorId && !mongoose.isValidObjectId(creatorId)) {
      return res.status(400).json({ message: "Invalid creator filter." });
    }

    const query: Record<string, any> = {
      promotedAt: null,
      promotionToken: null,
    };
    if (type !== 'all') query.type = type;
    if (status !== 'all') query.previewStatus = status;
    if (creatorId) query.user = creatorId;

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      const matchingOwners = await User.find({
        $or: [{ username: regex }, { email: regex }, { companyName: regex }],
      }).select("_id").lean();
      query.$or = [
        { contractNo: regex },
        { title: regex },
        { clientDraftId: regex },
        { user: { $in: matchingOwners.map((owner) => owner._id) } },
      ];
    }

    const [total, drafts] = await Promise.all([
      ReportDraft.countDocuments(query),
      ReportDraft.find(query)
        .populate("user", "username email companyName isBlocked")
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    const serialized = await Promise.all(drafts.map(toReportDraftClient));
    const items = serialized.map((draft: any) => {
      const lots = Array.isArray(draft.lots) ? draft.lots : [];
      const media = Array.isArray(draft.media) ? draft.media : [];
      const smartGroups = draft.smartUploadSummary?.groups || [];
      const imageCount = draft.storageMode === "smart_upload"
        ? smartGroups.reduce((sum: number, group: any) => sum + Number(group?.files?.length || group?.imageCount || 0), 0)
        : media.filter((item: any) => item.slot !== "video").length;
      const videoCount = media.filter((item: any) => item.slot === "video").length;
      const owner = draft.user && typeof draft.user === "object"
        ? ownerFromDocument(draft.user)
        : null;
      return {
        id: String(draft._id || draft.id),
        type: draft.type,
        title: draft.title || draft.contractNo || "Untitled draft",
        contractNo: draft.contractNo || "",
        clientDraftId: draft.clientDraftId,
        storageMode: draft.storageMode,
        revision: Number(draft.revision || 0),
        lotCount: smartGroups.length || lots.length,
        imageCount,
        videoCount,
        thumbnailUrl: media.find((item: any) => item.slot !== "video")?.url
          || smartGroups[0]?.files?.[0]?.url
          || null,
        previewStatus: draft.previewStatus || "idle",
        previewReportId: draft.previewReportId ? String(draft.previewReportId) : null,
        previewJobId: draft.previewJobId || null,
        previewError: draft.previewError || null,
        previewRequestedRevision: draft.previewRequestedRevision ?? null,
        previewProcessedRevision: draft.previewProcessedRevision ?? null,
        previewRequestedAt: draft.previewRequestedAt || null,
        previewReadyAt: draft.previewReadyAt || null,
        duplicateLotConflicts: Array.isArray(draft.duplicateLotConflicts)
          ? draft.duplicateLotConflicts
          : [],
        reviewReminderSentAt: draft.reviewReminderSentAt || null,
        creator: owner,
        creatorDisplay: ownerDisplay(owner || undefined),
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      };
    });
    const pages = Math.max(1, Math.ceil(total / limit));
    return res.json({ items, total, page, limit, pages });
  } catch (error) {
    console.error("Failed to list admin draft previews:", error);
    return res.status(500).json({ message: "Unable to load draft previews." });
  }
}

/**
 * Permanently deletes a user-saved draft from the superadmin queue. The draft
 * is claimed with one conditional delete before any cleanup runs, preventing a
 * concurrent autosave or worker from being mistaken for an idle draft.
 */
export async function deleteAdminDraftPreview(req: Request, res: Response) {
  try {
    noStore(res);
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid draft id." });
    }

    const existing: any = await ReportDraft.findById(id)
      .select("user previewStatus previewJobId previewReportId smartUploadSession media promotedAt promotionToken")
      .lean();
    if (!existing) {
      return res.status(404).json({ message: "Draft not found." });
    }
    if (existing.promotedAt || existing.promotionToken) {
      return res.status(409).json({
        message: "This draft has already moved into the main report workflow and cannot be deleted as draft media.",
      });
    }

    const activeJob = existing.previewJobId
      ? await ReportJob.exists({
          jobId: existing.previewJobId,
          status: { $in: ["queued", "processing"] },
        })
      : null;
    if (["queued", "processing"].includes(String(existing.previewStatus)) || activeJob) {
      return res.status(409).json({
        message: "This draft preview is actively processing. Wait for it to finish before deleting it.",
      });
    }

    const deleted: any = await ReportDraft.findOneAndDelete({
      _id: id,
      previewStatus: { $nin: ["queued", "processing"] },
      promotedAt: null,
      promotionToken: null,
    }).lean();
    if (!deleted) {
      return res.status(409).json({
        message: "This draft changed while it was being deleted. Refresh and try again.",
      });
    }

    const smartSession: any = deleted.smartUploadSession
      ? await ReportUploadSession.findById(deleted.smartUploadSession)
          .select("files r2Bucket r2PublicBaseUrl")
          .lean()
      : null;
    const cleanupResults = await Promise.allSettled([
      deleteHiddenDraftPreview(deleted._id, deleted.user),
      deleteDraftMediaObjects(Array.isArray(deleted.media) ? deleted.media : []),
      deleted.previewJobId
        ? ReportJob.deleteMany({ jobId: deleted.previewJobId }).exec()
        : Promise.resolve(),
      deleted.smartUploadSession
        ? ReportUploadSession.deleteOne({ _id: deleted.smartUploadSession }).exec()
        : Promise.resolve(),
    ]);

    // Smart Upload files live on their upload session rather than the draft's
    // media manifest, so remove those source objects explicitly as well.
    const smartStorage = resolvePersistedR2StorageTarget(smartSession);
    if (
      isCurrentR2StorageTarget(smartStorage) &&
      Array.isArray(smartSession?.files)
    ) {
      const keys = Array.from(
        new Set<string>(
          smartSession.files
            .map((file: any) => String(file?.key || "").trim())
            .filter(Boolean)
        )
      );
      const objectResults = await Promise.allSettled(
        keys.map((key) => deleteFromR2(smartStorage.bucketName, key))
      );
      cleanupResults.push(...objectResults);
    }

    const warnings = cleanupResults.flatMap((result) =>
      result.status === "rejected"
        ? [String(result.reason?.message || result.reason || "Draft cleanup failed.")]
        : []
    );
    return res.json({
      message: "Draft deleted successfully.",
      draftId: id,
      warnings,
    });
  } catch (error) {
    console.error("Failed to delete admin draft preview:", error);
    return res.status(500).json({ message: "Unable to delete this draft." });
  }
}

function selectedLotsExpression() {
  return {
    $let: {
      vars: {
        previewLots: {
          $cond: [{ $isArray: "$preview_data.lots" }, "$preview_data.lots", []],
        },
        savedLots: {
          $cond: [{ $isArray: "$lots" }, "$lots", []],
        },
      },
      in: {
        $cond: [
          { $gt: [{ $size: "$$previewLots" }, 0] },
          "$$previewLots",
          "$$savedLots",
        ],
      },
    },
  };
}

function summaryProjection(reportType: PreviewReportType) {
  const selectedLots = selectedLotsExpression();
  // Match canonical preview semantics without fetching full photo/lot arrays.
  // An explicit empty preview is authoritative; only the known failed legacy
  // Lot defaults shell may fall back to root rows.
  const defaultShell = { $and: [
    { $eq: ["$status", "error"] },
    { $eq: ["$preview_data.include_damage_analysis", true] },
    { $eq: ["$preview_data.bank_photos_enabled", false] },
    { $eq: ["$preview_data.valuation_methods", ["FML"]] },
    { $allElementsTrue: [{ $map: {
      input: { $objectToArray: { $cond: [{ $eq: [{ $type: "$preview_data" }, "object"] }, "$preview_data", {}] } },
      as: "entry", in: { $or: [
        { $in: ["$$entry.k", ["include_damage_analysis", "bank_photos_enabled", "valuation_methods"]] },
        { $and: [
          { $in: ["$$entry.k", ["lots", "deleted_image_indexes", "deleted_image_urls", "videoUrls"]] },
          { $eq: ["$$entry.v", []] },
        ] },
      ] },
    } }] },
  ] };
  const transferLots = reportType === "Asset"
    ? { $cond: [{ $isArray: "$preview_data.lots" }, "$preview_data.lots", []] }
    : { $cond: [
        { $or: [{ $eq: [{ $ifNull: ["$preview_data", null] }, null] }, defaultShell] },
        { $cond: [{ $isArray: "$lots" }, "$lots", []] },
        { $cond: [{ $isArray: "$preview_data.lots" }, "$preview_data.lots", []] },
      ] };
  return {
    _id: 1,
    user: 1,
    reportType: { $literal: reportType },
    contractNo: { $ifNull: ["$preview_data.contract_no", "$contract_no"] },
    clientName: {
      $ifNull: [
        "$preview_data.client_name",
        { $ifNull: ["$client_name", { $ifNull: ["$prepared_for", "$preview_data.inspector_name"] }] },
      ],
    },
    status: 1,
    release_status: 1,
    job_status: 1,
    job_error: 1,
    error_message: 1,
    files_generating: 1,
    files_regenerating: 1,
    files_regeneration_pending: 1,
    excel_regenerating: 1,
    proposal_valuation_regeneration_claim_token: 1,
    artifact_publish_token: 1,
    artifact_publish_expires_at: 1,
    proposal_valuation_artifact_publish_token: 1,
    proposal_valuation_artifact_publish_expires_at: 1,
    report_job_outbox: { $ne: [{ $ifNull: ["$report_job_outbox", null] }, null] },
    validSavedLots: { $and: [
      { $gt: [{ $size: transferLots }, 0] },
      { $allElementsTrue: [{ $map: { input: transferLots, as: "lot", in: { $gt: [
        { $size: { $objectToArray: { $cond: [{ $eq: [{ $type: "$$lot" }, "object"] }, "$$lot", {}] } } }, 0],
      } } }] },
    ] },
    processing_completed_at: 1,
    preview_submitted_at: 1,
    approval_requested_at: 1,
    generation_target_status: 1,
    generation_progress: 1,
    preview_files: 1,
    files: 1,
    preview_transferred_from: 1,
    preview_transferred_to: 1,
    preview_transferred_by: 1,
    preview_transferred_at: 1,
    preview_reminder_sent_at: 1,
    preview_reminder_claimed_at: 1,
    lotCount: { $size: selectedLots },
    imageCount: {
      $let: {
        vars: {
          globalImages: { $cond: [{ $isArray: "$imageUrls" }, "$imageUrls", []] },
          lots: selectedLots,
        },
        in: {
          $cond: [
            { $gt: [{ $size: "$$globalImages" }, 0] },
            { $size: "$$globalImages" },
            {
              $reduce: {
                input: "$$lots",
                initialValue: 0,
                in: {
                  $add: [
                    "$$value",
                    {
                      $size: {
                        $cond: [
                          { $isArray: "$$this.image_urls" },
                          "$$this.image_urls",
                          [],
                        ],
                      },
                    },
                    {
                      $size: {
                        $cond: [
                          { $isArray: "$$this.extra_image_urls" },
                          "$$this.extra_image_urls",
                          [],
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    },
    lotNumbers: {
      $map: {
        input: selectedLots,
        as: "lot",
        in: { $ifNull: ["$$lot.lot_number", ""] },
      },
    },
    thumbnailUrl: {
      $let: {
        vars: {
          firstLot: { $arrayElemAt: [selectedLots, 0] },
        },
        in: {
          $ifNull: [
            {
              $arrayElemAt: [
                {
                  $cond: [
                    { $isArray: "$$firstLot.image_urls" },
                    "$$firstLot.image_urls",
                    [],
                  ],
                },
                0,
              ],
            },
            {
              $ifNull: [
                "$$firstLot.image_url",
                { $arrayElemAt: [{ $cond: [{ $isArray: "$imageUrls" }, "$imageUrls", []] }, 0] },
              ],
            },
          ],
        },
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

async function loadActiveRows(
  model: typeof AssetReport | typeof LotListing,
  reportType: PreviewReportType,
  match: Record<string, unknown>
) {
  return model.aggregate<PreviewSummaryRow>([
    { $match: match },
    { $project: summaryProjection(reportType) },
    { $sort: { updatedAt: -1, _id: -1 } },
    { $limit: MAX_ACTIVE_ROWS_PER_COLLECTION },
  ]);
}

function ownerFromDocument(owner: any): SafeOwner {
  return {
    id: String(owner?._id || ""),
    username: String(owner?.username || ""),
    email: String(owner?.email || ""),
    companyName: String(owner?.companyName || ""),
    isBlocked: Boolean(owner?.isBlocked),
  };
}

function ownerDisplay(owner?: SafeOwner) {
  return owner?.username || owner?.companyName || owner?.email || "Deleted user";
}

function lotNumberSummary(numbers: Array<string | number>) {
  const values = numbers.map((value) => String(value ?? "").trim()).filter(Boolean);
  if (!values.length) return "No lot numbers";
  if (values.length <= 3) return values.map((value) => `Lot ${value}`).join(", ");
  return `${values.slice(0, 3).map((value) => `Lot ${value}`).join(", ")} +${values.length - 3} more`;
}

function rowSearchText(row: PreviewSummaryRow, owner?: SafeOwner) {
  return [
    row.contractNo,
    row.clientName,
    row.reportType,
    row.status,
    owner?.username,
    owner?.email,
    owner?.companyName,
    ...row.lotNumbers,
  ]
    .map((value) => String(value ?? "").toLocaleLowerCase())
    .join(" ");
}

function serializeRow(row: PreviewSummaryRow, owner?: SafeOwner) {
  const workflow = resolveReportGenerationState(row, row.preview_files, row.files);
  const transfer = getPreviewTransferEligibility(row);
  const deletion = getPreviewDeleteEligibility(row);
  const reminder = getPreviewReminderEligibility({
    allowFailed: true, report: row, hasActiveJob: row.hasActiveJob, hasSavedPreview: row.validSavedLots === true,
    workflowStage: workflow.workflow_stage,
    previewSubmittedAt: row.preview_submitted_at,
    approvalRequestedAt: row.approval_requested_at,
    owner: owner
      ? {
          _id: owner.id,
          username: owner.username,
          email: owner.email,
          companyName: owner.companyName,
          isBlocked: owner.isBlocked,
        }
      : null,
  });
  return {
    id: String(row._id),
    reportType: row.reportType,
    title: `${row.reportType === "Asset" ? "Asset" : "Lot Listing"} - ${row.contractNo || "Unassigned"}`,
    contractNo: row.contractNo || "",
    clientName: row.clientName || "",
    creator: owner || null,
    creatorDisplay: ownerDisplay(owner),
    lotCount: Number(row.lotCount || 0),
    imageCount: Number(row.imageCount || 0),
    lotNumbers: row.lotNumbers,
    lotNumberSummary: lotNumberSummary(row.lotNumbers),
    thumbnailUrl: row.thumbnailUrl || null,
    status: row.status || "",
    releaseStatus: row.release_status || "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    previewSubmittedAt: row.preview_submitted_at || null,
    workflowStage: workflow.workflow_stage,
    workflowMessage: workflow.workflow_message,
    workflowProgressPercent: workflow.workflow_progress_percent,
    generationState: workflow.generation_state,
    filesReady: workflow.files_ready,
    jobStatus: workflow.job_status || "",
    jobError: workflow.job_error || "",
    transferEligible: transfer.eligible,
    transferIneligibleReason: transfer.reason,
    transferRequiresReview: isFailedSubmittedPreview(row),
    deleteEligible: deletion.eligible,
    deleteIneligibleReason: deletion.reason,
    reminderEligible: reminder.eligible,
    reminderIneligibleReason: reminder.reason,
    reminderWaitingSince: row.processing_completed_at || row.updatedAt || row.createdAt,
    reminderSentAt: row.preview_reminder_sent_at || null,
    previewTransferredAt: row.preview_transferred_at || null,
  };
}

function getPreviewDeleteEligibility(report: any): {
  eligible: boolean;
  reason: string | null;
} {
  if (
    report?.files_generating === true ||
    report?.files_regenerating === true ||
    ["queued", "processing"].includes(String(report?.job_status || ""))
  ) {
    return {
      eligible: false,
      reason: "Wait for the active report job to finish before deleting this preview.",
    };
  }

  const workflow = resolveReportGenerationState(
    report,
    report?.preview_files,
    report?.files
  );
  if (!PREVIEW_STAGES.has(workflow.workflow_stage)) {
    return {
      eligible: false,
      reason: "Only reports currently shown in Preview Reports can be deleted here.",
    };
  }

  return { eligible: true, reason: null };
}

function collectArtifactUrls(value: unknown, output = new Set<string>()) {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    output.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectArtifactUrls(entry, output));
  } else if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((entry) =>
      collectArtifactUrls(entry, output)
    );
  }
  return output;
}

/**
 * Lists only active preview/workflow records. Large lot and image arrays are
 * reduced inside MongoDB so opening this operations page cannot pull entire
 * reports into memory. Complete data is fetched only by the detail endpoint.
 */
export async function getAdminPreviewReports(req: Request, res: Response) {
  try {
    noStore(res);
    const { page, limit } = parsePagination(req);
    const from = safeDate(req.query.from);
    const to = safeDate(req.query.to, true);
    const search = escapeSearch(req.query.search);
    const reportType = String(req.query.reportType || "all");
    const stage = String(req.query.workflowStage || "all") as ReportWorkflowStage | "all";
    const creatorId = String(req.query.creatorId || "").trim();
    const sort = String(req.query.sort || "updated_desc");

    if (creatorId && !mongoose.isValidObjectId(creatorId)) {
      return res.status(400).json({ message: "Invalid creator filter." });
    }
    if (stage !== "all" && !PREVIEW_STAGES.has(stage)) {
      return res.status(400).json({ message: "Invalid workflow-stage filter." });
    }
    if (!["all", "Asset", "LotListing"].includes(reportType)) {
      return res.status(400).json({ message: "Invalid report-type filter." });
    }

    const match = activePreviewMatch(from, to);
    const requests: Array<Promise<PreviewSummaryRow[]>> = [];
    if (reportType === "all" || reportType === "Asset") {
      requests.push(loadActiveRows(AssetReport, "Asset", match));
    }
    if (reportType === "all" || reportType === "LotListing") {
      requests.push(loadActiveRows(LotListing, "LotListing", match));
    }

    const rows = (await Promise.all(requests)).flat();
    const activeJobs = rows.length ? await ReportJob.distinct("reportId", {
      reportId: { $in: rows.map((row) => String(row._id)) }, status: { $in: ["queued", "processing"] },
    }) : [];
    const activeReportIds = new Set(activeJobs);
    rows.forEach((row) => { row.hasActiveJob = activeReportIds.has(String(row._id)); });
    const ownerIds = Array.from(new Set(rows.map((row) => String(row.user || "")).filter(Boolean)));
    const ownerDocs = ownerIds.length
      ? await User.find({ _id: { $in: ownerIds } })
          .select("username email companyName isBlocked")
          .lean()
      : [];
    const owners = new Map(ownerDocs.map((owner) => [String(owner._id), ownerFromDocument(owner)]));

    const serialized = rows
      .map((row) => ({ row, item: serializeRow(row, owners.get(String(row.user || ""))) }))
      .filter(({ item }) => PREVIEW_STAGES.has(item.workflowStage))
      .filter(({ row }) => !creatorId || String(row.user || "") === creatorId)
      .filter(({ row }) => !search || rowSearchText(row, owners.get(String(row.user || ""))).includes(search));

    const stageCounts = serialized.reduce<Record<string, number>>(
      (counts, { item }) => {
        counts[item.workflowStage] = (counts[item.workflowStage] || 0) + 1;
        return counts;
      },
      Object.fromEntries(Array.from(PREVIEW_STAGES).map((value) => [value, 0]))
    );

    const filtered = stage === "all"
      ? serialized
      : serialized.filter(({ item }) => item.workflowStage === stage);

    filtered.sort((left, right) => {
      const leftTime = new Date(sort === "created_asc" || sort === "created_desc" ? left.item.createdAt : left.item.updatedAt).getTime();
      const rightTime = new Date(sort === "created_asc" || sort === "created_desc" ? right.item.createdAt : right.item.updatedAt).getTime();
      return sort.endsWith("_asc") ? leftTime - rightTime : rightTime - leftTime;
    });

    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, pages);
    const start = (safePage - 1) * limit;
    const creators = Array.from(owners.values())
      .sort((left, right) => ownerDisplay(left).localeCompare(ownerDisplay(right)))
      .map((owner) => ({ ...owner, displayName: ownerDisplay(owner) }));

    return res.json({
      items: filtered.slice(start, start + limit).map(({ item }) => item),
      total,
      page: safePage,
      limit,
      pages,
      stageCounts,
      creators,
      truncated: rows.length >= MAX_ACTIVE_ROWS_PER_COLLECTION * requests.length,
    });
  } catch (error) {
    console.error("Failed to list admin preview reports:", error);
    return res.status(500).json({ message: "Unable to load preview reports." });
  }
}

export async function getAdminPreviewReport(req: Request, res: Response) {
  try {
    noStore(res);
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid report id." });
    }

    const [asset, listing] = await Promise.all([
      AssetReport.findById(id)
        .select("+report_job_outbox")
        .populate("user", "username email companyName isBlocked")
        .lean(),
      LotListing.findById(id)
        .select("+report_job_outbox")
        .populate("user", "username email companyName isBlocked")
        .lean(),
    ]);
    const report: any = asset || listing;
    if (!report) return res.status(404).json({ message: "Preview report not found." });

    const preview = await getReportPreviewPayloadById(id);
    if (!preview) return res.status(404).json({ message: "Preview report data is unavailable." });

    const reportType: PreviewReportType = asset ? "Asset" : "LotListing";
    const workflow = resolveReportGenerationState(report, report.preview_files, report.files);
    const lots = savedLotsForPreviewTransfer(asset ? "asset" : "lotListing", report);
    const hasActiveJob = Boolean(await ReportJob.exists({ reportId: String(id), status: { $in: ["queued", "processing"] } }));
    const transfer = getPreviewTransferEligibility({
      ...report,
      lotCount: lots.length,
      validSavedLots: hasValidLotsForPreviewTransfer(lots),
      hasActiveJob,
    });
    const deletion = getPreviewDeleteEligibility(report);
    const reminder = getPreviewReminderEligibility({
      allowFailed: true, report, hasActiveJob, hasSavedPreview: hasValidLotsForPreviewTransfer(lots),
      workflowStage: workflow.workflow_stage,
      previewSubmittedAt: report.preview_submitted_at,
      approvalRequestedAt: report.approval_requested_at,
      owner: report.user,
    });
    return res.json({
      report: {
        id,
        reportType,
        contractNo: String(report.contract_no || (preview.data as any)?.contract_no || ""),
        creator: report.user ? ownerFromDocument(report.user) : null,
        status: report.status || "",
        releaseStatus: report.release_status || "",
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
        previewSubmittedAt: report.preview_submitted_at || null,
        transferEligible: transfer.eligible,
        transferIneligibleReason: transfer.reason,
        transferRequiresReview: isFailedSubmittedPreview(report),
        deleteEligible: deletion.eligible,
        deleteIneligibleReason: deletion.reason,
        reminderEligible: reminder.eligible,
        reminderIneligibleReason: reminder.reason,
        reminderWaitingSince:
          report.processing_completed_at || report.updatedAt || report.createdAt,
        reminderSentAt: report.preview_reminder_sent_at || null,
        previewTransferredAt: report.preview_transferred_at || null,
        transferHistory: Array.isArray(report.preview_transfer_history)
          ? report.preview_transfer_history
          : [],
        ...workflow,
        ...getReportResubmitState(asset ? "asset" : "lotListing", report),
      },
      preview: { ...preview, reportId: id },
    });
  } catch (error) {
    console.error("Failed to load admin preview report detail:", error);
    return res.status(500).json({ message: "Unable to load preview report details." });
  }
}

/** Submit only the authoritative saved snapshot, never client-supplied report data. */
export async function resubmitAdminPreviewReport(req: AdminAuthRequest, res: Response) {
  noStore(res);
  try {
    const id = String(req.params.id || "");
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid report id." });
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 || typeof body.baseRevision !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.baseRevision)) {
      return res.status(400).json({ message: "A saved preview revision is required. Refresh and review the preview first." });
    }
    if (!req.userId) return res.status(401).json({ message: "Not authorized." });
    const [asset, listing] = await Promise.all([AssetReport.exists({ _id: id }), LotListing.exists({ _id: id })]);
    if (!asset && !listing) return res.status(404).json({ message: "Preview report not found." });
    const result = await resubmitSavedReportPreview({ kind: asset ? "asset" : "lotListing",
      reportId: id, baseRevision: body.baseRevision, actorId: req.userId });
    return res.status(202).json(result);
  } catch (error: any) {
    const status = Number(error?.statusCode);
    if ([400, 404, 409, 503].includes(status)) return res.status(status).json({ message: error.message });
    console.error("Failed to resubmit saved admin preview.");
    return res.status(500).json({ message: "Unable to resubmit the saved preview. Refresh to check its processing status before trying again." });
  }
}

/**
 * Sends a review reminder to the report's authoritative owner. Recipient data
 * is never accepted from the client, which prevents this administrative action
 * from being used to send email to an arbitrary address.
 */
export async function getAdminPreviewReminder(req: Request, res: Response) {
  noStore(res);
  try {
    const id = String(req.params.id || "").toLowerCase();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid report id." });
    }
    return res.json(await getAdminPreviewReminderDraft(id));
  } catch (error: any) {
    if (error?.statusCode === 404) return res.status(404).json({ message: error.message });
    console.error("Unable to prepare an admin preview notification draft.");
    return res.status(500).json({ message: "Unable to prepare the notification draft." });
  }
}

export async function sendAdminPreviewReminder(req: AdminAuthRequest, res: Response) {
  noStore(res);
  try {
    const id = String(req.params.id || "").toLowerCase();
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid report id." });
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 4 ||
      Object.keys(body).some((key) => !["subject", "message", "baseRevision", "requestId"].includes(key)) ||
      typeof body.subject !== "string" || typeof body.message !== "string" ||
      typeof body.baseRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.baseRevision) ||
      typeof body.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.requestId)) {
      return res.status(400).json({ message: "Review the notification draft and provide its subject, message, revision and request ID." });
    }
    const subject = body.subject.trim();
    const message = body.message.replace(/\r\n?/g, "\n").trim();
    if (subject.length < 3 || subject.length > 180 || /[\u0000-\u001f\u007f]/.test(body.subject) ||
      message.length < 10 || message.length > 10_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) {
      return res.status(400).json({ message: "Use a single-line subject of 3–180 characters and a plain-text message of 10–10,000 characters." });
    }
    if (!req.userId) return res.status(401).json({ message: "Not authorized." });
    const delivery = await sendReviewedAdminPreviewReminder({ reportId: id, actorId: req.userId, subject, message,
      baseRevision: body.baseRevision, requestId: body.requestId.toLowerCase() });
    return res.status(delivery.statusCode).json(delivery.body);
  } catch (error: any) {
    if ([400, 404, 409].includes(error?.statusCode)) return res.status(error.statusCode).json({ message: error.message, code: error.code,
      ...(error.pendingDelivery ? { pendingDelivery: error.pendingDelivery } : {}) });
    console.error("Admin preview notification delivery could not be confirmed.");
    return res.status(503).json({ code: "REMINDER_DELIVERY_UNCONFIRMED", message: "Delivery could not be confirmed. Keep the same request ID and check its status; do not send a new notification." });
  }
}

/**
 * Permanently removes one report that is still in the Preview Reports queue.
 * Active jobs are never cancelled here: deleting a record underneath a worker
 * could let that worker recreate artifacts after the admin receives success.
 */
export async function deleteAdminPreviewReport(req: Request, res: Response) {
  try {
    noStore(res);
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid report id." });
    }

    const [asset, listing, activeJob] = await Promise.all([
      AssetReport.findById(id)
        .select(
          "user status release_status job_status files_generating files_regenerating preview_files files client_submission_id"
        )
        .lean(),
      LotListing.findById(id)
        .select(
          "user status release_status job_status files_generating files_regenerating preview_files files client_submission_id"
        )
        .lean(),
      ReportJob.exists({ reportId: id, status: { $in: ["queued", "processing"] } }),
    ]);
    const report: any = asset || listing;
    if (!report) {
      return res.status(404).json({ message: "Preview report not found." });
    }

    if (activeJob) {
      return res.status(409).json({
        message: "This report is actively processing. Wait for the job to finish before deleting it.",
      });
    }

    const eligibility = getPreviewDeleteEligibility(report);
    if (!eligibility.eligible) {
      return res.status(409).json({ message: eligibility.reason });
    }

    const model: any = asset ? AssetReport : LotListing;
    const reportType: PreviewReportType = asset ? "Asset" : "LotListing";
    const deleted: any = await model
      .findOneAndDelete({
        _id: new mongoose.Types.ObjectId(id),
        files_generating: { $ne: true },
        files_regenerating: { $ne: true },
        job_status: { $nin: ["queued", "processing"] },
      })
      .lean();
    if (!deleted) {
      return res.status(409).json({
        message: "This preview changed while it was being deleted. Refresh and try again.",
      });
    }

    const cleanupTasks: Array<Promise<unknown>> = [
      ReportJob.deleteMany({ reportId: id }).exec(),
      ReportUploadSession.deleteMany({ reportId: id }).exec(),
      PdfReport.deleteMany({ report: id } as any).exec(),
    ];
    const clientDraftId = String(deleted.client_submission_id || "").trim();
    if (clientDraftId && deleted.user) {
      cleanupTasks.push(
        ReportDraft.deleteMany({
          user: deleted.user,
          type: asset ? "asset" : "lotListing",
          clientDraftId,
        }).exec()
      );
    }
    const cleanupResults = await Promise.allSettled(cleanupTasks);
    const warnings = cleanupResults.flatMap((result) =>
      result.status === "rejected"
        ? [String(result.reason?.message || result.reason || "Related metadata cleanup failed.")]
        : []
    );

    // Only generated report artifacts are removed. Source photos can be shared
    // by merged reports, drafts, and immutable upload sessions, so deleting
    // those objects here could corrupt another report.
    const artifactUrls = collectArtifactUrls(deleted.preview_files);
    collectArtifactUrls(deleted.files, artifactUrls);
    const locations = Array.from(artifactUrls)
      .map(resolveCurrentR2ObjectLocationFromUrl)
      .filter((location): location is NonNullable<typeof location> => Boolean(location));
    const uniqueLocations = new Map(
      locations.map((location) => [`${location.bucketName}:${location.key}`, location])
    );
    await Promise.all(
      Array.from(uniqueLocations.values()).map((location) =>
        deleteFromR2(location.bucketName, location.key)
      )
    );

    return res.json({
      message: "Preview report deleted successfully.",
      reportId: id,
      reportType,
      warnings,
    });
  } catch (error) {
    console.error("Failed to delete admin preview report:", error);
    return res.status(500).json({ message: "Unable to delete this preview report." });
  }
}

export async function getAdminPreviewTransferUsers(req: Request, res: Response) {
  try {
    noStore(res);
    const search = String(req.query.search || "").trim().slice(0, 120);
    const limit = Math.min(
      500,
      Math.max(1, Number.parseInt(String(req.query.limit || "250"), 10) || 250)
    );
    const match: Record<string, unknown> = {
      isBlocked: { $ne: true },
      isReviewAccount: { $ne: true },
    };
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      match.$or = [
        { username: { $regex: safe, $options: "i" } },
        { email: { $regex: safe, $options: "i" } },
        { companyName: { $regex: safe, $options: "i" } },
      ];
    }

    const users = await User.find(match)
      .select("username email companyName role isBlocked")
      .sort({ username: 1, email: 1 })
      .limit(limit)
      .lean();

    return res.json({
      users: users.map((user: any) => ({
        id: String(user._id),
        username: String(user.username || ""),
        email: String(user.email || ""),
        companyName: String(user.companyName || ""),
        role: String(user.role || "user"),
        displayName:
          String(user.username || "").trim() ||
          String(user.companyName || "").trim() ||
          String(user.email || "").trim() ||
          "User",
      })),
    });
  } catch (error) {
    console.error("Failed to list preview transfer users:", error);
    return res.status(500).json({ message: "Unable to load users for reassignment." });
  }
}

function transferAtomicMatch(
  id: string,
  currentOwnerId: string,
  current: any,
  kind: "asset" | "lotListing"
): Record<string, unknown> {
  const exactField = (key: string) => ({ [key]: current[key] === undefined ? { $exists: false } : current[key] });
  const exactSavedValue = (key: string) => current[key] === undefined
    ? { [key]: { $exists: false } }
    : { $expr: { $eq: [`$${key}`, { $literal: current[key] }] } };
  return {
    _id: new mongoose.Types.ObjectId(id),
    user: new mongoose.Types.ObjectId(currentOwnerId),
    adminArchivedAt: null,
    is_draft_preview: { $ne: true },
    files_generating: { $ne: true },
    files_regenerating: { $ne: true },
    files_regeneration_pending: { $ne: true },
    excel_regenerating: { $ne: true },
    job_status: { $nin: ["queued", "processing"] },
    $and: [
      ...["status", "job_status", "job_id", "job_execution_token", "job_error", "updatedAt",
        "preview_submitted_at", "approval_requested_at", "approval_processed_at", "release_status",
        "files_generating", "files_regenerating", "files_regeneration_pending", "excel_regenerating",
        "proposal_valuation_regeneration_claim_token", "excel_cr_regeneration_claim_token"].map(exactField),
      exactSavedValue("preview_data"),
      exactSavedValue("lots"),
      { $or: [{ report_job_outbox: { $exists: false } }, { report_job_outbox: null }] },
      kind === "asset" ? proposalValuationWritableRevisionCondition(Number(current.proposal_valuation_revision || 0))
        : lotListingArtifactPublicationAvailableCondition(),
    ],
  };
}

/**
 * Moves a stable preview to another owner. The report update is guarded by the
 * original owner and workflow state so a concurrent submission cannot be
 * transferred after it starts. Failed submissions return to manual review with
 * their error and data intact. Terminal job payloads remain immutable history.
 */
export async function transferAdminPreviewReport(
  req: AdminAuthRequest,
  res: Response
) {
  try {
    noStore(res);
    const { id } = req.params;
    const targetUserId = String(req.body?.targetUserId || "").trim();
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(targetUserId)) {
      return res.status(400).json({ message: "A valid preview and target user are required." });
    }

    const targetUser = await User.findOne({
      _id: targetUserId,
      isBlocked: { $ne: true },
      isReviewAccount: { $ne: true },
    })
      .select("username email companyName role isBlocked")
      .lean();
    if (!targetUser) {
      return res.status(404).json({ message: "The selected user is unavailable or blocked." });
    }

    const [asset, listing] = await Promise.all([
      AssetReport.findById(id)
        .select("+report_job_outbox +report_recovery +job_execution_token")
        .lean(),
      LotListing.findById(id)
        .select("+report_job_outbox +report_recovery +job_execution_token")
        .lean(),
    ]);
    const current: any = asset || listing;
    if (!current) {
      return res.status(404).json({ message: "Preview report not found." });
    }

    const currentOwnerId = String(current.user || "");
    if (!currentOwnerId || !mongoose.isValidObjectId(currentOwnerId)) {
      return res.status(409).json({ message: "This preview has no valid current owner." });
    }
    if (currentOwnerId === targetUserId) {
      return res.status(400).json({ message: "Select a different user." });
    }

    const kind = asset ? "asset" : "lotListing";
    const lots = savedLotsForPreviewTransfer(kind, current);
    const hasActiveJob = Boolean(await ReportJob.exists({ reportId: String(id), status: { $in: ["queued", "processing"] } }));
    const eligibility = getPreviewTransferEligibility({
      ...current,
      lotCount: lots.length,
      validSavedLots: hasValidLotsForPreviewTransfer(lots),
      hasActiveJob,
    });
    if (!eligibility.eligible) {
      return res.status(409).json({ message: eligibility.reason });
    }

    const currentOwner = await User.findById(currentOwnerId)
      .select("username email companyName role isBlocked isReviewAccount")
      .lean();
    if (currentOwner?.isReviewAccount === true || await ReviewAccountBoundary.exists({ _id: currentOwnerId })) {
      return res.status(400).json({ message: "Review reports cannot be transferred into production accounts." });
    }
    if (!currentOwner) {
      return res.status(409).json({ message: "The current preview owner no longer exists." });
    }

    const reportType: PreviewReportType = asset ? "Asset" : "LotListing";
    const model: any = asset ? AssetReport : LotListing;
    const transferredAt = new Date();
    const adminId = String(req.userId || req.user?._id || "");
    if (!mongoose.isValidObjectId(adminId)) return res.status(401).json({ message: "Not authorized." });
    const failedSubmission = isFailedSubmittedPreview(current);
    const transferJobId = `transfer-${randomUUID()}`;
    const transferReceipt = {
      mode: "transfer", manualReviewRequired: true, jobId: transferJobId,
      previousJobId: current.job_id || null, actorId: adminId, createdAt: transferredAt,
      fromOwnerId: currentOwnerId, toOwnerId: targetUserId,
      previousStatus: current.status, previousJobStatus: current.job_status,
      previousSubmittedAt: current.preview_submitted_at || null,
      previousApprovalRequestedAt: current.approval_requested_at || null,
      previousApprovalProcessedAt: current.approval_processed_at || null,
      previousReleaseStatus: current.release_status || null,
      previousReleasedAt: current.released_at || null,
    };
    const update = {
      $set: {
        user: new mongoose.Types.ObjectId(targetUserId),
        preview_transferred_from: new mongoose.Types.ObjectId(currentOwnerId),
        preview_transferred_to: new mongoose.Types.ObjectId(targetUserId),
        preview_transferred_by: new mongoose.Types.ObjectId(adminId),
        preview_transferred_at: transferredAt,
        // Invalidate old source-completion and worker callbacks as well as
        // execution attempts. Their original logical ID remains in history;
        // this tombstone is not a queued job or a new submission.
        job_id: transferJobId,
        job_execution_token: `transfer-${randomUUID()}`,
        report_recovery: transferReceipt,
        ...(failedSubmission ? { status: "error" } : {}),
      },
      $push: {
        report_recovery_history: transferReceipt,
        preview_transfer_history: {
          fromUser: new mongoose.Types.ObjectId(currentOwnerId),
          toUser: new mongoose.Types.ObjectId(targetUserId),
          transferredBy: new mongoose.Types.ObjectId(adminId),
          transferredAt,
        },
      },
      $unset: {
        preview_submitted_at: "",
        approval_requested_at: "",
        approval_processed_at: "",
        approval_assignment_email_sent_at: "",
        approval_assignment_email_claim_token: "",
        generation_target_status: "",
        approval_assigned_to: "",
        approval_assigned_at: "",
        approval_assigned_source: "",
        approval_notification_sent_at: "",
        release_assigned_to: "",
        release_assigned_at: "",
        release_assigned_source: "",
        release_assignment_email_sent_at: "",
        release_assignment_email_claim_token: "",
        release_notification_sent_at: "",
        released_by: "",
        released_at: "",
        release_status: "",
      },
    };

    // Compare-and-swap prevents an admin transfer from racing a user submit.
    const transferred = await model
      .findOneAndUpdate(
        transferAtomicMatch(id, currentOwnerId, current, kind),
        update,
        { returnDocument: "after", runValidators: true }
      )
      .select("_id user contract_no status preview_transferred_at")
      .lean();
    if (!transferred) {
      return res.status(409).json({
        message:
          "This preview changed while it was being reassigned. Refresh and try again.",
      });
    }

    // The report is the ownership source of truth. Ancillary records are
    // aligned best-effort so a transient bookkeeping failure cannot make an
    // already completed transfer appear to have failed.
    const alignmentResults = await Promise.allSettled([
      ReportUploadSession.updateMany(
        { reportId: id, user: current.user, status: { $in: ["completed", "processed", "failed"] } },
        { $set: { user: new mongoose.Types.ObjectId(targetUserId) } }
      ),
    ]);

    const alignmentWarnings = alignmentResults.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            `Ownership bookkeeping ${index + 1} needs reconciliation: ${String(
              result.reason?.message || result.reason
            )}`,
          ]
        : []
    );
    const notificationWarnings = await notifyPreviewOwnershipTransfer({
      reportId: id,
      reportType,
      contractNo: String(transferred.contract_no || current.contract_no || ""),
      fromUser: currentOwner,
      toUser: targetUser,
      transferredBy: req.user || { _id: adminId },
    });
    const warnings = [...alignmentWarnings, ...notificationWarnings];

    return res.json({
      message: failedSubmission
        ? "Failed preview reassigned. The new owner must review and resubmit it; no files have been queued."
        : "Preview reassigned successfully.",
      requiresReview: failedSubmission,
      reportId: id,
      reportType,
      transferredAt,
      creator: ownerFromDocument(targetUser),
      warnings,
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.status(409).json({
        message:
          "This user already has a submission with the same internal id. Select another user.",
      });
    }
    console.error("Failed to transfer preview report:", error);
    return res.status(500).json({ message: "Unable to reassign this preview." });
  }
}
