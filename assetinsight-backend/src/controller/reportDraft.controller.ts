/**
 * Authenticated autosave-draft and draft-media transport layer.
 *
 * Client submission ids provide a stable retry key across devices and reconnects.
 * Draft payloads and uploaded objects are always resolved through the current user.
 * Target creation records pending media descriptors; confirmation verifies object
 * existence/size and marks those descriptors available for restoration.
 */
import { Response } from "express";
import { createHash } from "node:crypto";
import fs from "fs/promises";
import mongoose from "mongoose";
import ReportDraft from "../models/reportDraft.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import { AuthRequest } from "../middleware/auth.middleware.js";
import {
  normalizeDraftClientId,
  normalizeDraftContract,
  toReportDraftClient,
} from "../service/reportDraftService.js";
import {
  confirmDraftMedia,
  createDraftMediaTargets,
  deleteDraftMediaObjects,
  deleteSelectedDraftMedia,
  mergeDraftMediaManifest,
  normalizeDraftMediaManifest,
  uploadMultipartDraftMedia,
} from "../service/reportDraftMediaService.js";
import {
  getR2ObjectStream,
  isR2ObjectNotFoundError,
  resolvePersistedR2StorageTarget,
} from "../utils/r2Storage/r2Upload.js";
import {
  deleteHiddenDraftPreview,
  queueReportDraftPreview,
} from "../service/reportDraftPreviewService.js";
import {
  DUPLICATE_LOT_DETECTED,
  duplicateLotMessage,
  findContractLotConflicts,
} from "../service/contractLotUniquenessService.js";
import {
  applyReportDraftPromotionContractClaim,
  claimReportDraftPreviewPromotion,
  completeReportDraftPreviewPromotion,
  findCurrentReportFileGenerationJob,
  isReportDraftPromotionClaimStale,
  reportDraftPromotionClaimCutoff,
  rollbackReportDraftPreviewPromotion,
  type ReportDraftPromotionClaim,
} from "../service/reportDraftPromotionService.js";
import {
  isSubmissionContractClaimDuplicateKeyError,
  releaseInactiveSubmissionContractClaim,
  resolveSubmissionContractClaim,
} from "../service/reportSubmissionConflictService.js";
import {
  activeUploadSessionConflict,
  findActiveUploadSessionContractOwner,
  withReportSubmissionAdmission,
} from "../service/reportSubmissionAdmissionService.js";
import {
  resubmitReport as resubmitAssetReport,
  submitForApproval as submitAssetReport,
} from "./asset.controller.js";
import {
  resubmitLotListing,
  submitLotListingForApproval,
} from "./lotListing.controller.js";

const MAX_DRAFT_JSON_BYTES = 2 * 1024 * 1024;

const setNoStore = (res: Response) => res.setHeader("Cache-Control", "no-store");

function stableDraftValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableDraftValue);
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== "object") return value;
  if (typeof value.toHexString === "function") return value.toHexString();
  return Object.keys(value)
    .sort()
    .reduce<Record<string, any>>((result, key) => {
      if (value[key] !== undefined) result[key] = stableDraftValue(value[key]);
      return result;
    }, {});
}

function clientOwnedDraftMedia(value: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(value) ? value : []).map((raw: any) => {
    const item = typeof raw?.toObject === "function"
      ? raw.toObject({ versionKey: false, virtuals: false })
      : raw || {};
    return {
      clientFileId: item.clientFileId || "",
      localKey: item.localKey || "",
      mediaId: item.mediaId || "",
      lotId: item.lotId || "",
      slot: item.slot || "main",
      index: Number(item.index) || 0,
      captureOrder: Number(item.captureOrder) || 0,
      originalOrder: Number(item.originalOrder) || 0,
      name: item.name || "",
      mimeType: item.mimeType || "application/octet-stream",
      size: Number(item.size) || 0,
      lastModified: Number(item.lastModified) || 0,
    };
  });
}

function hashDraftContent(value: Record<string, any>): string {
  // R2 keys, verification timestamps, and uploaded sizes are server-owned
  // transport state. They can advance after the metadata save without making
  // the user's logical revision different.
  const logicalValue = {
    ...value,
    media: clientOwnedDraftMedia(value.media),
  };
  return createHash("sha256")
    .update(JSON.stringify(stableDraftValue(logicalValue)))
    .digest("hex");
}

function draftMediaRevisionFilter(revision: number): Record<string, unknown> {
  return revision > 0
    ? { mediaRevision: revision }
    : {
        $or: [
          { mediaRevision: 0 },
          { mediaRevision: null },
          { mediaRevision: { $exists: false } },
        ],
      };
}

function draftContentFromDocument(draft: any): Record<string, unknown> {
  const value = typeof draft?.toObject === "function"
    ? draft.toObject({ depopulate: true, versionKey: false, virtuals: false })
    : draft || {};
  return {
    storageMode: value.storageMode,
    smartUploadSession: value.smartUploadSession
      ? String(value.smartUploadSession)
      : null,
    deviceId: value.deviceId || "",
    contractNo: value.contractNo || "",
    title: value.title || "",
    formData: value.formData || {},
    lots: Array.isArray(value.lots) ? value.lots : [],
    activeLotIdx: Number(value.activeLotIdx) || 0,
    media: value.storageMode === "smart_upload"
      ? []
      : Array.isArray(value.media)
        ? value.media
        : [],
  };
}

function hasEmbeddedMedia(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return /^data:(image|video|application\/octet-stream)/i.test(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) return value.some((item) => hasEmbeddedMedia(item, seen));
  return Object.values(value as Record<string, unknown>).some((item) => hasEmbeddedMedia(item, seen));
}

function assertMetadataOnly(body: unknown) {
  if (hasEmbeddedMedia(body)) {
    throw Object.assign(
      new Error("Draft image/video bytes must be uploaded to R2; only media descriptors belong in JSON."),
      { statusCode: 413 }
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify(body || {}), "utf8");
  if (bytes > MAX_DRAFT_JSON_BYTES) {
    throw Object.assign(
      new Error("Draft metadata is too large. Image/video bytes must not be included."),
      { statusCode: 413 }
    );
  }
}

async function serializeDrafts(drafts: any[]) {
  return Promise.all(drafts.map(toReportDraftClient));
}

function recoverableUnpromotedDraftFilter() {
  return {
    promotedAt: null,
    $or: [
      { promotionToken: null },
      { promotionClaimedAt: null },
      { promotionClaimedAt: { $lte: reportDraftPromotionClaimCutoff() } },
    ],
  };
}

export const listReportDrafts = async (req: AuthRequest, res: Response) => {
  try {
    setNoStore(res);
    const type = String(req.query.type || "");
    const filter: Record<string, unknown> = {
      user: req.userId as any,
      ...recoverableUnpromotedDraftFilter(),
    };
    if (["asset", "lotListing"].includes(type)) filter.type = type;
    const drafts = await ReportDraft.find(filter).sort({ updatedAt: -1 }).select("-__v");
    res.status(200).json({
      message: "Drafts fetched successfully",
      data: await serializeDrafts(drafts),
    });
  } catch (error: any) {
    console.error("Error fetching report drafts:", error);
    res.status(500).json({ message: error?.message || "Failed to fetch drafts" });
  }
};

export const upsertReportDraft = async (req: AuthRequest, res: Response) => {
  try {
    setNoStore(res);
    assertMetadataOnly(req.body);
    const {
      clientDraftId: rawClientDraftId,
      type,
      storageMode = "r2_media",
      smartUploadSessionId,
      revision = 0,
      deviceId,
      contractNo,
      title,
      formData,
      lots,
      activeLotIdx,
      media,
    } = req.body || {};
    if (!["asset", "lotListing"].includes(type)) {
      return res.status(400).json({ message: "Draft type must be asset or lotListing" });
    }
    if (!["local_media", "r2_media", "smart_upload"].includes(storageMode)) {
      return res.status(400).json({ message: "Invalid draft storage mode" });
    }
    const clientDraftId = normalizeDraftClientId(rawClientDraftId);
    if (!clientDraftId) return res.status(400).json({ message: "clientDraftId is required" });
    const nextRevision = Math.max(0, Number(revision) || 0);
    const identity = { user: req.userId as any, type, clientDraftId };
    let existing: any = await ReportDraft.findOne(identity).select(
      "-__v +mediaRevision",
    );
    if ((existing as any)?.promotedAt || (existing as any)?.promotionToken) {
      return res.status(409).json({
        code: "DRAFT_ALREADY_PROMOTED",
        message: "This draft was already moved to the main report workflow.",
        reportId: String((existing as any).promotedReportId || "") || undefined,
      });
    }
    if (existing && Number(existing.revision || 0) > nextRevision) {
      return res.status(409).json({
        code: "STALE_DRAFT_REVISION",
        message: "A newer draft revision already exists.",
        data: await toReportDraftClient(existing),
      });
    }

    let smartUploadSession: any = undefined;
    if (storageMode === "smart_upload") {
      smartUploadSession = await ReportUploadSession.findOne({
        _id: smartUploadSessionId as any,
        user: req.userId as any,
        type,
        smartUpload: true,
      });
      if (!smartUploadSession) {
        return res.status(400).json({ message: "Smart Upload session was not found for this draft." });
      }
    }

    const cleanContractNo = String(contractNo || "").trim();
    const incomingManifest =
      storageMode !== "smart_upload" && Object.prototype.hasOwnProperty.call(req.body || {}, "media")
        ? normalizeDraftMediaManifest(media)
        : null;
    const buildNextContent = (current: any) => {
      const mergedManifest = storageMode === "smart_upload"
        ? []
        : incomingManifest
          ? mergeDraftMediaManifest(incomingManifest, current?.media || [])
          : current?.media || [];
      const nextContent = {
        storageMode,
        smartUploadSession: smartUploadSession
          ? String(smartUploadSession._id)
          : null,
        deviceId: String(deviceId || "").slice(0, 200),
        contractNo: cleanContractNo,
        title: String(title || "").trim().slice(0, 300),
        formData: formData && typeof formData === "object" ? formData : {},
        lots: Array.isArray(lots) ? lots : [],
        activeLotIdx: Number.isFinite(Number(activeLotIdx))
          ? Math.max(0, Number(activeLotIdx))
          : 0,
        media: mergedManifest,
      };
      return { nextContent, contentHash: hashDraftContent(nextContent) };
    };

    const idempotentDraftResponse = async (current: any) => {
      const conflicts = Array.isArray(current?.duplicateLotConflicts)
        ? current.duplicateLotConflicts
        : [];
      return res.status(200).json({
        message: conflicts.length
          ? duplicateLotMessage(conflicts)
          : "Draft already synced",
        code: conflicts.length ? DUPLICATE_LOT_DETECTED : undefined,
        warning: conflicts.length > 0,
        conflicts,
        data: await toReportDraftClient(current),
        idempotent: true,
      });
    };

    // Form autosave and media target/confirm/delete calls share one media CAS.
    // Rebuild the merge from the winning manifest on every retry so autosave
    // can neither erase a concurrent upload nor resurrect a deleted R2 key.
    let draft: any = null;
    let contentHash = "";
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt > 0) {
        existing = await ReportDraft.findOne(identity).select(
          "-__v +mediaRevision",
        );
      }
      if (existing?.promotedAt || existing?.promotionToken) {
        return res.status(409).json({
          code: "DRAFT_ALREADY_PROMOTED",
          message: "This draft was already moved to the main report workflow.",
          reportId: String(existing.promotedReportId || "") || undefined,
        });
      }
      if (existing && Number(existing.revision || 0) > nextRevision) {
        return res.status(409).json({
          code: "STALE_DRAFT_REVISION",
          message: "A newer draft revision already exists.",
          data: await toReportDraftClient(existing),
        });
      }

      const built = buildNextContent(existing);
      contentHash = built.contentHash;
      if (existing && Number(existing.revision || 0) === nextRevision) {
        // Always derive this from the current document. Media mutations do not
        // advance the form revision and may legitimately change the logical
        // manifest after the last stored contentHash was written.
        const existingHash = hashDraftContent(
          draftContentFromDocument(existing),
        );
        if (existingHash === contentHash) {
          return idempotentDraftResponse(existing);
        }
        return res.status(409).json({
          code: "DRAFT_REVISION_CONFLICT",
          message:
            "This draft revision contains different changes from another tab or device. Refresh before saving again.",
          data: await toReportDraftClient(existing),
        });
      }

      const expectedMediaRevision = Math.max(
        0,
        Number(existing?.mediaRevision) || 0,
      );
      const update = {
        $set: {
          ...built.nextContent,
          ...(smartUploadSession
            ? { smartUploadSession: smartUploadSession._id }
            : { smartUploadSession: null }),
          revision: nextRevision,
          mediaRevision: expectedMediaRevision + 1,
          contentHash,
          normalizedContractNo: normalizeDraftContract(cleanContractNo),
          // Editing restarts the inactivity window. A later reminder is about
          // the current saved revision instead of stale work.
          reviewReminderSentAt: null,
          reviewReminderClaimedAt: null,
          reviewReminderError: "",
          reviewReminderRecipientIds: [],
        },
        $setOnInsert: { user: req.userId as any, type, clientDraftId },
      };

      try {
        draft = await ReportDraft.findOneAndUpdate(
          existing
            ? {
                ...identity,
                revision: Number(existing.revision || 0),
                promotedAt: null,
                promotionToken: null,
                ...draftMediaRevisionFilter(expectedMediaRevision),
              }
            : {
                ...identity,
                // The unique identity index arbitrates simultaneous first
                // saves; the loser reloads and resolves idempotently below.
                revision: { $exists: false },
              },
          update,
          {
            new: true,
            upsert: !existing,
            runValidators: true,
            setDefaultsOnInsert: true,
          },
        ).select("-__v +mediaRevision");
      } catch (error: any) {
        if (!existing && Number(error?.code) === 11000) {
          existing = null;
          continue;
        }
        throw error;
      }
      if (draft) break;
      existing = null;
    }

    if (!draft) {
      const current = await ReportDraft.findOne(identity).select("-__v");
      return res.status(409).json({
        code: "DRAFT_MEDIA_CONFLICT",
        message:
          "This draft's media changed repeatedly in another request. Refresh and retry the save.",
        data: current ? await toReportDraftClient(current) : undefined,
      });
    }
    // Omitted objects are intentionally not deleted during autosave. A client
    // can lose connectivity between manifest persistence and R2 confirmation;
    // retaining the old object keeps that media recoverable. Explicit media or
    // draft deletion remains responsible for permanent object cleanup.
    const duplicateLotConflicts = await findContractLotConflicts({
      contractNo: cleanContractNo,
      lots: Array.isArray(lots) ? lots : [],
      excludeDraftId: draft._id,
      excludeReportId: draft.previewReportId,
    });
    const conflictWrite = await ReportDraft.updateOne(
      {
        _id: draft._id,
        revision: nextRevision,
        contentHash,
        promotedAt: null,
        promotionToken: null,
      },
      { $set: { duplicateLotConflicts } }
    );
    if (conflictWrite.matchedCount !== 1) {
      const current = await ReportDraft.findOne(identity).select("-__v");
      return res.status(409).json({
        code: "STALE_DRAFT_REVISION",
        message: "A newer draft revision already exists.",
        data: current ? await toReportDraftClient(current) : undefined,
      });
    }
    draft.duplicateLotConflicts = duplicateLotConflicts as any;

    res.status(200).json({
      message: duplicateLotConflicts.length
        ? duplicateLotMessage(duplicateLotConflicts)
        : "Draft synced successfully",
      code: duplicateLotConflicts.length ? DUPLICATE_LOT_DETECTED : undefined,
      warning: duplicateLotConflicts.length > 0,
      conflicts: duplicateLotConflicts,
      data: await toReportDraftClient(draft),
    });
  } catch (error: any) {
    console.error("Error syncing report draft:", error);
    if (error?.code === 11000) return res.status(409).json({ message: "This draft was updated elsewhere. Refresh and try again." });
    res.status(Number(error?.statusCode) || 500).json({ message: error?.message || "Failed to sync draft" });
  }
};

export const getReportDraft = async (req: AuthRequest, res: Response) => {
  try {
    setNoStore(res);
    const draft = await ReportDraft.findOne({
      _id: req.params.id,
      user: req.userId as any,
      ...recoverableUnpromotedDraftFilter(),
    }).select("-__v");
    if (!draft) return res.status(404).json({ message: "Draft not found" });
    res.status(200).json({ message: "Draft fetched successfully", data: await toReportDraftClient(draft) });
  } catch (error: any) {
    res.status(500).json({ message: error?.message || "Failed to fetch draft" });
  }
};

export const getReportDraftByClientId = async (req: AuthRequest, res: Response) => {
  try {
    setNoStore(res);
    const type = String(req.query.type || "");
    const draft = await ReportDraft.findOne({
      user: req.userId as any,
      clientDraftId: normalizeDraftClientId(req.params.clientDraftId),
      ...recoverableUnpromotedDraftFilter(),
      ...(["asset", "lotListing"].includes(type) ? { type } : {}),
    }).select("-__v");
    if (!draft) return res.status(404).json({ message: "Draft not found" });
    res.status(200).json({ message: "Draft fetched successfully", data: await toReportDraftClient(draft) });
  } catch (error: any) {
    res.status(500).json({ message: error?.message || "Failed to fetch draft" });
  }
};

export const processReportDraftPreview = async (req: AuthRequest, res: Response) => {
  try {
    setNoStore(res);
    const data = await queueReportDraftPreview(String(req.params.id), String(req.userId));
    res.status(202).json({
      message: "Draft preview processing started. You can safely leave this page.",
      data,
    });
  } catch (error: any) {
    res.status(Number(error?.statusCode) || 500).json({
      code: error?.code,
      message: error?.message || "Failed to process draft preview",
      conflicts: error?.conflicts,
    });
  }
};

function promotedReportPayload(report: any, reportType: "asset" | "lotListing") {
  return {
    reportId: String(report?._id || ""),
    reportType,
    status: String(report?.status || "preview"),
    preview_data: report?.preview_data || {},
    files_generating: Boolean(report?.files_generating),
    files_regenerating: Boolean(report?.files_regenerating),
  };
}

function retainedPromotionClaim(draft: any, report: any): ReportDraftPromotionClaim {
  const forceNew = [true, "true", 1, "1"].includes(
    draft?.formData?.force_new as any
  );
  return {
    draftId: String(draft?._id || ""),
    reportId: String(report?._id || ""),
    revision: Number(draft?.revision || 0),
    token: String(draft?.promotionToken || ""),
    resumed: true,
    forceNew,
    submissionContractClaim: resolveSubmissionContractClaim({
      contractNo: draft?.contractNo || draft?.formData?.contract_no,
      forceNew,
    }),
  };
}

async function ensureDraftReportVisible(
  report: any,
  reportType: "asset" | "lotListing",
  claim: ReportDraftPromotionClaim
) {
  if (report?.is_draft_preview !== true) return true;
  const contractClaim = applyReportDraftPromotionContractClaim(report, claim);
  return withReportSubmissionAdmission(
    { reportType, userId: report.user, contractClaim },
    async (admission) => {
      const uploadOwner = await findActiveUploadSessionContractOwner({
        reportType,
        userId: report.user,
        contractClaim,
      });
      if (uploadOwner) throw activeUploadSessionConflict(uploadOwner);

      await releaseInactiveSubmissionContractClaim({
        reportType,
        userId: report.user,
        contractClaim,
      });
      const update = {
        $set: {
          is_draft_preview: false,
          ...(contractClaim
            ? { submission_contract_claim: contractClaim }
            : {}),
          ...(claim.forceNew
            ? { submission_contract_claim_bypassed: true }
            : {}),
        },
        $unset: {
          ...(!contractClaim ? { submission_contract_claim: 1 } : {}),
          ...(!claim.forceNew
            ? { submission_contract_claim_bypassed: 1 }
            : {}),
        },
      };
      let result;
      try {
        await admission?.assertOwned();
        result = reportType === "asset"
          ? await AssetReport.updateOne(
              { _id: report._id, is_draft_preview: true },
              update
            )
          : await LotListing.updateOne(
              { _id: report._id, is_draft_preview: true },
              update
            );
      } catch (error) {
        if (isSubmissionContractClaimDuplicateKeyError(error)) {
          throw Object.assign(
            new Error(
              "A report for this contract is already being processed. Use the existing report or explicitly create a separate one."
            ),
            { code: "ACTIVE_REPORT_EXISTS", statusCode: 409, cause: error }
          );
        }
        throw error;
      }
      if (result.matchedCount === 1) report.is_draft_preview = false;
      return result.matchedCount === 1;
    },
  );
}

async function markMissingDraftFileJobRetryable(
  report: any,
  reportType: "asset" | "lotListing"
) {
  const jobId = String(report?.job_id || "").trim();
  const previousStatus = String(
    reportType === "lotListing"
      ? report?.generation_progress?.previousStatus || "error"
      : report?.status || "error"
  );
  const retryStatus = reportType === "asset"
    ? (["approved", "pending_approval"].includes(previousStatus)
        ? previousStatus
        : "error")
    : previousStatus === "approved"
      ? "approved"
      : "error";
  const message = "The previous file-generation request was not queued. Submit again to retry.";
  const filter = {
    _id: report._id,
    ...(jobId ? { job_id: jobId } : {}),
    job_status: { $in: ["queued", "processing"] },
    $or: [{ files_generating: true }, { files_regenerating: true }],
  };
  const update = {
    $set: {
      status: retryStatus,
      files_generating: false,
      files_regenerating: false,
      job_status: "error",
      job_error: message,
      processing_completed_at: new Date(),
      generation_progress: {
        stage: "error",
        progressPercent: 100,
        message,
        ...(reportType === "lotListing" ? { previousStatus } : {}),
        updatedAt: new Date(),
      },
    },
  };
  const result = reportType === "asset"
    ? await AssetReport.updateOne(filter as any, update as any)
    : await LotListing.updateOne(filter as any, update as any);
  if (result.matchedCount === 1) {
    report.status = retryStatus;
    report.files_generating = false;
    report.files_regenerating = false;
    report.job_status = "error";
    report.job_error = message;
  }
  return result;
}

function delegateDraftSubmission(
  req: AuthRequest,
  res: Response,
  report: any,
  reportType: "asset" | "lotListing"
) {
  req.params = { ...req.params, id: String(report._id) };
  const shouldResubmit = Boolean(report.preview_submitted_at) ||
    ["pending_approval", "approved", "error", "processing"].includes(
      String(report.status || "")
    );
  if (reportType === "asset") {
    return shouldResubmit
      ? resubmitAssetReport(req, res)
      : submitAssetReport(req, res);
  }
  return shouldResubmit
    ? resubmitLotListing(req, res)
    : submitLotListingForApproval(req, res);
}

/**
 * Move a revision-bound hidden draft derivative into the normal report flow.
 * `submit:true` delegates to the existing validated submit/resubmit handlers,
 * which also claim the draft and queue artifacts from the exact request
 * snapshot. Move-only promotes the already-saved ready preview without
 * generating files.
 */
export const promoteReportDraftPreview = async (
  req: AuthRequest,
  res: Response
) => {
  let promotionClaim: ReportDraftPromotionClaim | null = null;
  let promotionPersisted = false;
  try {
    setNoStore(res);
    const draftId = String(req.params.id || "");
    if (!mongoose.isValidObjectId(draftId)) {
      return res.status(400).json({ message: "Invalid draft id." });
    }
    const draft: any = await ReportDraft.findOne({
      _id: draftId,
      user: req.userId as any,
    });

    // Retained source ids let a lost response be retried even if an older
    // deployment deleted the ReportDraft row after promoting the report.
    if (!draft) {
      const promotedAsset: any = await AssetReport.findOne({
        user: req.userId as any,
        source_draft_id: draftId as any,
        is_draft_preview: { $ne: true },
      });
      const promotedListing: any = promotedAsset
        ? null
        : await LotListing.findOne({
            user: req.userId as any,
            source_draft_id: draftId as any,
            is_draft_preview: { $ne: true },
          });
      const promoted = promotedAsset || promotedListing;
      if (!promoted) return res.status(404).json({ message: "Draft not found." });
      const reportType = promotedAsset ? "asset" : "lotListing";
      return res.status(200).json({
        message: "Draft preview was already moved.",
        data: promotedReportPayload(promoted, reportType),
      });
    }

    const reportType = draft.type === "lotListing" ? "lotListing" : "asset";
    const reportFilter = {
      _id: draft.previewReportId as any,
      user: req.userId as any,
      source_draft_id: draft._id,
    };
    const report: any = reportType === "asset"
      ? await AssetReport.findOne(reportFilter)
      : await LotListing.findOne(reportFilter);
    if (!report) {
      if (
        draft.promotionToken &&
        !isReportDraftPromotionClaimStale(draft.promotionClaimedAt)
      ) {
        return res.status(409).json({
          code: "DRAFT_PROMOTION_IN_PROGRESS",
          message: "This draft preview is already being moved. Wait a moment and try again.",
        });
      }

      // A worker/report deletion after a crashed promotion claim would
      // otherwise leave this draft permanently locked: every ordinary draft
      // mutation correctly refuses rows with promotionToken. Reclaim only an
      // expired (or unclaimed) ready-preview record and reset its derived
      // preview metadata so the user can prepare the same source media again.
      const recoveryFilter: Record<string, unknown> = {
        _id: draft._id,
        user: req.userId as any,
        promotedAt: null,
        previewReportId: draft.previewReportId,
      };
      if (draft.promotionToken) {
        recoveryFilter.promotionToken = draft.promotionToken;
        recoveryFilter.promotionClaimedAt = draft.promotionClaimedAt;
      } else {
        recoveryFilter.promotionToken = null;
      }
      const recovery = await ReportDraft.updateOne(recoveryFilter, {
        $set: { previewStatus: "idle" },
        $unset: {
          previewReportId: 1,
          previewJobId: 1,
          previewRequestedRevision: 1,
          previewProcessedRevision: 1,
          previewError: 1,
          previewRequestedAt: 1,
          previewReadyAt: 1,
          promotedReportId: 1,
          promotedSubmitted: 1,
          promotionToken: 1,
          promotionClaimedAt: 1,
        },
      });
      return res.status(409).json({
        code: recovery.matchedCount === 1
          ? "DRAFT_PREVIEW_MISSING"
          : "DRAFT_PROMOTION_CONFLICT",
        message: recovery.matchedCount === 1
          ? "The prepared report for this draft is no longer available. The draft was restored; prepare its preview again."
          : "The draft changed while its missing preview was being recovered. Refresh and try again.",
      });
    }

    const submit = req.body?.submit === true;
    if (draft.promotedAt) {
      if (
        !(await ensureDraftReportVisible(
          report,
          reportType,
          retainedPromotionClaim(draft, report)
        ))
      ) {
        return res.status(409).json({
          code: "DRAFT_PROMOTION_CONFLICT",
          message: "The report changed while it was being moved. Refresh and try again.",
        });
      }
      if (!submit) {
        return res.status(200).json({
          message: "Draft preview was already moved.",
          data: promotedReportPayload(report, reportType),
        });
      }

      if (report.preview_submitted_at) {
        if (report.files_generating || report.files_regenerating) {
          // promotedAt is written only after the queue accepted the work, or
          // after a rejected enqueue was reconciled to a non-generating error.
          // This also supports the intentional in-memory development queue,
          // which has no ReportJob row to inspect.
          return res.status(202).json({
            message: "Draft preview is already submitted and its files are being generated.",
            data: promotedReportPayload(report, reportType),
          });
        } else if (String(report.job_status || "") !== "error") {
          return res.status(200).json({
            message: "Draft preview was already submitted.",
            data: promotedReportPayload(report, reportType),
          });
        }
      }
      // A move-only promotion can later be submitted by a stale/open editor.
      return delegateDraftSubmission(req, res, report, reportType);
    }

    const revision = Number(draft.revision || 0);
    if (
      draft.previewStatus !== "ready" ||
      Number(draft.previewProcessedRevision ?? -1) !== revision ||
      Number(report.source_draft_revision ?? -1) !== revision
    ) {
      return res.status(409).json({
        code: "STALE_DRAFT_PREVIEW",
        message: "This draft changed after its preview was prepared. Prepare the latest revision first.",
      });
    }

    if (submit) {
      // A worker can finish between durable queue acceptance and persisting
      // the retained draft's promotedAt marker. Reconcile the exact job even
      // after it clears the report's generation flags, otherwise a retry
      // would enqueue the already-completed snapshot a second time.
      if (report.preview_submitted_at && report.is_draft_preview !== true) {
        const durableJob: any = await findCurrentReportFileGenerationJob({
          report,
          type: reportType,
        });
        if (durableJob) {
          if (draft.promotionToken) {
            promotionClaim = retainedPromotionClaim(draft, report);
          } else {
            promotionClaim = await claimReportDraftPreviewPromotion({
              draftId: draft._id,
              reportId: report._id,
              userId: req.userId,
              revision,
              type: reportType,
              submit: true,
            });
          }
          if (!(await ensureDraftReportVisible(report, reportType, promotionClaim))) {
            throw Object.assign(
              new Error("The report changed while it was being moved. Refresh and try again."),
              { statusCode: 409, code: "DRAFT_PROMOTION_CONFLICT" }
            );
          }
          promotionPersisted = true;
          await completeReportDraftPreviewPromotion(promotionClaim);
          const active = ["queued", "processing"].includes(
            String(durableJob.status || "")
          );
          return res.status(active ? 202 : 200).json({
            message: active
              ? "Draft preview is already submitted and its files are being generated."
              : "Draft preview was already submitted.",
            data: promotedReportPayload(report, reportType),
          });
        }
      }

      if (
        (report.files_generating || report.files_regenerating) &&
        report.preview_submitted_at
      ) {
        if (
          draft.promotionToken &&
          !isReportDraftPromotionClaimStale(draft.promotionClaimedAt)
        ) {
          return res.status(409).json({
            code: "DRAFT_PROMOTION_IN_PROGRESS",
            message: "This draft preview is already being submitted. Wait a moment and try again.",
          });
        }

        promotionClaim = await claimReportDraftPreviewPromotion({
          draftId: draft._id,
          reportId: report._id,
          userId: req.userId,
          revision,
          type: reportType,
          submit: true,
        });
        if (!(await ensureDraftReportVisible(report, reportType, promotionClaim))) {
          throw Object.assign(
            new Error("The report changed while it was being moved. Refresh and try again."),
            { statusCode: 409, code: "DRAFT_PROMOTION_CONFLICT" }
          );
        }
        // This recovery starts from a report state already persisted by an
        // earlier submit attempt. Once visible, never roll its draft linkage
        // back even if another request wins the generation-state CAS below.
        promotionPersisted = true;
        const recovery = await markMissingDraftFileJobRetryable(report, reportType);
        if (recovery.matchedCount !== 1) {
          await completeReportDraftPreviewPromotion(promotionClaim);
          throw Object.assign(
            new Error("The report changed while its file-generation state was being recovered. Refresh and try again."),
            { statusCode: 409, code: "DRAFT_PROMOTION_CONFLICT" }
          );
        }
        await completeReportDraftPreviewPromotion(promotionClaim);
        draft.promotionToken = undefined;
        draft.promotionClaimedAt = undefined;
        draft.promotedAt = new Date();
      }

      if (
        draft.promotionToken &&
        !isReportDraftPromotionClaimStale(draft.promotionClaimedAt)
      ) {
        return res.status(409).json({
          code: "DRAFT_PROMOTION_IN_PROGRESS",
          message: "This draft preview is already being submitted. Wait a moment and try again.",
        });
      }
      if (draft.promotionToken && report.is_draft_preview !== true) {
        promotionClaim = await claimReportDraftPreviewPromotion({
          draftId: draft._id,
          reportId: report._id,
          userId: req.userId,
          revision,
          type: reportType,
          submit: true,
        });
        promotionPersisted = true;
        await completeReportDraftPreviewPromotion(promotionClaim);
      }
      return delegateDraftSubmission(req, res, report, reportType);
    }

    if (report.files_generating || report.files_regenerating) {
      return res.status(409).json({
        code: "FILES_GENERATING",
        message: "Wait for the current report work to finish before moving this draft preview.",
      });
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "preview_data")) {
      return res.status(400).json({
        message: "Save preview changes first, then move the saved draft preview.",
      });
    }

    promotionClaim = await claimReportDraftPreviewPromotion({
      draftId: draft._id,
      reportId: report._id,
      userId: req.userId,
      revision,
      type: reportType,
      submit: false,
    });
    if (!(await ensureDraftReportVisible(report, reportType, promotionClaim))) {
      throw Object.assign(
        new Error("The report changed while it was being moved. Refresh and try again."),
        { statusCode: 409, code: "DRAFT_PROMOTION_CONFLICT" }
      );
    }
    promotionPersisted = true;
    await completeReportDraftPreviewPromotion(promotionClaim);

    return res.status(200).json({
      message: "Draft preview moved to main previews.",
      data: promotedReportPayload(report, reportType),
    });
  } catch (error: any) {
    if (promotionClaim && !promotionPersisted) {
      await rollbackReportDraftPreviewPromotion(promotionClaim).catch(
        (rollbackError) =>
          console.error("Failed to roll back draft preview promotion:", rollbackError)
      );
    }
    const statusCode = Number(error?.statusCode);
    if (!Number.isInteger(statusCode) || statusCode >= 500) {
      console.error("Error promoting report draft preview:", error);
    }
    return res.status(Number.isInteger(statusCode) ? statusCode : 500).json({
      ...(error?.code ? { code: String(error.code) } : {}),
      message: error?.message || "Failed to move draft preview.",
    });
  }
};

const safeDownloadName = (value: unknown) => {
  const original = String(value || "draft-media")
    .replace(/[\r\n"]/g, "")
    .replace(/[\\/:*?<>|]/g, "-")
    .slice(0, 180) || "draft-media";
  const ascii =
    original
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/g, "")
      .trim() || "draft-media";
  return { original, ascii };
};

/**
 * Stream owned draft media through the authenticated API. This avoids making
 * draft recovery depend on a public R2 URL or browser CORS configuration and
 * enforces ownership before any object bytes are returned.
 */
export const streamReportDraftMedia = async (req: AuthRequest, res: Response) => {
  try {
    setNoStore(res);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Draft media not found" });
    }
    const draft = await ReportDraft.findOne({
      _id: req.params.id,
      user: req.userId as any,
      ...recoverableUnpromotedDraftFilter(),
    })
      .select("media")
      .lean();
    if (!draft) return res.status(404).json({ code: "DRAFT_NOT_FOUND", message: "This draft is no longer available to this account. Return to Drafts and refresh the list." });
    const media = (draft.media || []).find(
      (item: any) => String(item.clientFileId) === String(req.params.clientFileId)
    ) as any;
    if (!media) return res.status(409).json({ code: "DRAFT_MEDIA_CHANGED", message: "The saved photo list changed. Retry loading the latest draft." });
    if (!media.r2Key) return res.status(409).json({ code: "DRAFT_MEDIA_UPLOAD_INCOMPLETE", message: "This original was not uploaded completely. Keep the original on the device used to save this draft." });
    const storageTarget = resolvePersistedR2StorageTarget(media);
    if (!storageTarget.bucketName) {
      throw new Error("R2 bucket is not configured");
    }
    const object = await getR2ObjectStream(
      storageTarget.bucketName,
      String(media.r2Key)
    );
    // A lost confirmation response must not hide an intact saved original.
    // Read only the owner's persisted key and verify its size before streaming;
    // this GET never changes the manifest or marks an upload confirmed.
    const expectedSize = Number(media.size);
    const actualSize = Number(object.contentLength);
    if (!Number.isSafeInteger(actualSize) || actualSize <= 0 ||
      (!media.uploadedAt && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) ||
      (expectedSize > 0 && expectedSize !== actualSize)) {
      object.stream.destroy();
      return res.status(409).json({ code: "DRAFT_MEDIA_SIZE_MISMATCH", message: "The saved original is incomplete or could not be verified. Keep the original on the device used to save this draft." });
    }
    res.setHeader(
      "Content-Type",
      String(media.mimeType || object.contentType || "application/octet-stream")
    );
    if (Number.isFinite(Number(object.contentLength))) {
      res.setHeader("Content-Length", String(object.contentLength));
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    const filename = safeDownloadName(media.name);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${filename.ascii}"; filename*=UTF-8''${encodeURIComponent(
        filename.original
      )}`
    );
    object.stream.once("error", (error) => {
      if (!res.headersSent) {
        res.removeHeader("Content-Length");
        res.removeHeader("Content-Disposition");
        res.status(502).json({ code: "DRAFT_MEDIA_UNAVAILABLE", message: "The original could not be downloaded. Retry loading the draft." });
      }
      else res.destroy(error as Error);
    });
    res.once("close", () => object.stream.destroy());
    object.stream.pipe(res);
  } catch (error: any) {
    if (!res.headersSent) {
      if (isR2ObjectNotFoundError(error)) {
        return res.status(409).json({ code: "DRAFT_MEDIA_MISSING", message: "This original is missing from storage. Keep the original on the device used to save this draft and contact support." });
      }
      // Provider error bodies can contain storage locations or signed requests.
      console.error("Draft media restore unavailable", { draftId: req.params.id, clientFileId: req.params.clientFileId });
      res.status(502).json({ code: "DRAFT_MEDIA_UNAVAILABLE", message: "Storage is temporarily unavailable. Retry loading the draft." });
    }
  }
};

export const deleteReportDraft = async (req: AuthRequest, res: Response) => {
  try {
    setNoStore(res);
    const draft = await ReportDraft.findOneAndDelete({
      _id: req.params.id,
      user: req.userId as any,
      promotedAt: null,
      promotionToken: null,
    });
    if (!draft) return res.status(404).json({ message: "Draft not found" });
    await deleteHiddenDraftPreview(draft._id, req.userId);
    await deleteDraftMediaObjects(draft.media || []);
    res.status(200).json({ message: "Draft deleted successfully" });
  } catch (error: any) {
    res.status(500).json({ message: error?.message || "Failed to delete draft" });
  }
};

export const deleteReportDraftByClientId = async (req: AuthRequest, res: Response) => {
  try {
    setNoStore(res);
    const type = String(req.query.type || "");
    const draft = await ReportDraft.findOneAndDelete({
      user: req.userId as any,
      clientDraftId: normalizeDraftClientId(req.params.clientDraftId),
      promotedAt: null,
      promotionToken: null,
      ...(["asset", "lotListing"].includes(type) ? { type } : {}),
    });
    if (!draft) return res.status(404).json({ message: "Draft not found" });
    await deleteHiddenDraftPreview(draft._id, req.userId);
    await deleteDraftMediaObjects(draft.media || []);
    res.status(200).json({ message: "Draft deleted successfully" });
  } catch (error: any) {
    res.status(500).json({ message: error?.message || "Failed to delete draft" });
  }
};

export const createReportDraftMediaTargets = async (req: AuthRequest, res: Response) => {
  try {
    setNoStore(res);
    const draft = await ReportDraft.findOne({
      _id: req.params.id,
      user: req.userId as any,
      promotedAt: null,
      promotionToken: null,
    });
    if (!draft) return res.status(404).json({ message: "Draft not found" });
    const targets = await createDraftMediaTargets(draft, req.body?.media);
    res.status(200).json({ message: "Draft upload targets created", data: targets });
  } catch (error: any) {
    console.error("Error creating draft media targets:", error);
    res.status(Number(error?.statusCode) || 500).json({
      message: error?.message || "Failed to create draft upload targets",
    });
  }
};

export const confirmReportDraftMedia = async (req: AuthRequest, res: Response) => {
  try {
    setNoStore(res);
    const draft = await ReportDraft.findOne({
      _id: req.params.id,
      user: req.userId as any,
      promotedAt: null,
      promotionToken: null,
    });
    if (!draft) return res.status(404).json({ message: "Draft not found" });
    const data = await confirmDraftMedia(draft, req.body?.clientFileIds);
    res.status(200).json({ message: "Draft media verified", data });
  } catch (error: any) {
    console.error("Error confirming draft media:", error);
    res.status(Number(error?.statusCode) || 500).json({
      message: error?.message || "Failed to verify draft media",
    });
  }
};

// Older mobile builds send multipart media through Node. Disk-backed Multer
// keeps memory bounded, and the manifest is committed only after every object
// reaches R2 so a failed upload cannot corrupt the previous valid revision.
export const uploadReportDraftMedia = async (req: AuthRequest, res: Response) => {
  const files = ((req as any).files || []) as Express.Multer.File[];
  try {
    setNoStore(res);
    const draft = await ReportDraft.findOne({
      _id: req.params.id,
      user: req.userId as any,
      promotedAt: null,
      promotionToken: null,
    });
    if (!draft) return res.status(404).json({ message: "Draft not found" });
    let metadata: unknown = [];
    try {
      metadata = JSON.parse(String(req.body?.metadata || "[]"));
    } catch {
      return res.status(400).json({ message: "Draft media metadata is invalid JSON." });
    }
    const data = await uploadMultipartDraftMedia(
      draft,
      files,
      metadata,
      String(req.body?.replace || "").toLowerCase() === "true"
    );
    res.status(200).json({ message: "Draft media saved to R2", data });
  } catch (error: any) {
    console.error("Error uploading draft media:", error);
    res.status(Number(error?.statusCode) || 500).json({
      message: error?.message || "Failed to upload draft media",
    });
  } finally {
    // Covers ownership/metadata failures that occur before the upload service
    // takes ownership of Multer's temporary files.
    await Promise.all(
      files.map((file) => fs.rm(file.path, { force: true }).catch(() => undefined))
    );
  }
};

export const deleteReportDraftMedia = async (req: AuthRequest, res: Response) => {
  try {
    setNoStore(res);
    const draft = await ReportDraft.findOne({
      _id: req.params.id,
      user: req.userId as any,
      promotedAt: null,
      promotionToken: null,
    });
    if (!draft) return res.status(404).json({ message: "Draft not found" });
    const data = await deleteSelectedDraftMedia(draft, req.body?.clientFileIds);
    res.status(200).json({ message: "Draft media removed", data });
  } catch (error: any) {
    res.status(Number(error?.statusCode) || 500).json({
      message: error?.message || "Failed to remove draft media",
    });
  }
};
