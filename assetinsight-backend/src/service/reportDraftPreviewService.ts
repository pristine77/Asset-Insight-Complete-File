import mongoose from "mongoose";
import { assertMixedLotPhotoManifest } from "../utils/mixedLotPhotoManifest.js";
import ReportDraft from "../models/reportDraft.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import User from "../models/user.model.js";
import {
  buildAssetPreviewJobOutbox,
  queueAssetPreviewJob,
  type AssetJobInput,
} from "../jobs/assetReportJob.js";
import {
  buildLotListingPreviewJobOutbox,
  queueLotListingJob,
  type LotListingJobInput,
} from "../jobs/lotListingJob.js";
import ReportJob from "../models/reportJob.model.js";
import {
  getR2PublicUrl,
  resolvePersistedR2StorageTarget,
} from "../utils/r2Storage/r2Upload.js";
import { sortDraftMedia } from "./reportDraftMediaService.js";
import { toReportDraftClient } from "./reportDraftService.js";
import { updateDraftPreviewLifecycle } from "./reportDraftPreviewLifecycleService.js";
import {
  duplicateLotError,
  findContractLotConflicts,
} from "./contractLotUniquenessService.js";
import {
  ensureReportJobOutbox,
  shouldUseMongoReportQueue,
  type ReportJobOutbox,
} from "../utils/reportJobMongoQueue.js";

type SerializedR2File = {
  fieldname: "images" | "videos";
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  filename: string;
  r2Key: string;
  r2Bucket: string;
  r2PublicUrl: string;
  lotIndex: number;
  imageIndex: number;
  captureOrder: number;
  originalOrder: number;
  role: "main" | "extra" | "video";
};

const draftLotId = (lot: any, index: number) =>
  String(lot?.lotId || lot?.lot_id || lot?.id || lot?._id || `lot-${index + 1}`);

function toR2File(
  input: any,
  lotIndex: number,
  imageIndex: number,
  storageSnapshot?: { r2Bucket?: unknown; r2PublicBaseUrl?: unknown }
): SerializedR2File {
  const role = input.role || input.slot || (input.fieldname === "videos" ? "video" : "main");
  const r2Key = String(input.r2Key || input.key || "");
  const storageTarget = resolvePersistedR2StorageTarget({
    r2Bucket: input.r2Bucket || storageSnapshot?.r2Bucket,
    r2PublicBaseUrl:
      input.r2PublicBaseUrl || storageSnapshot?.r2PublicBaseUrl,
  });
  return {
    fieldname: role === "video" ? "videos" : "images",
    originalname: String(input.name || input.originalname || `draft-${imageIndex + 1}`),
    encoding: "7bit",
    mimetype: String(input.mimeType || input.mimetype || (role === "video" ? "video/mp4" : "image/jpeg")),
    size: Number(input.verifiedSize || input.size || 0),
    filename: String(input.name || input.originalname || `draft-${imageIndex + 1}`),
    r2Key,
    r2Bucket: storageTarget.bucketName,
    r2PublicUrl: getR2PublicUrl(r2Key, storageTarget),
    lotIndex,
    imageIndex,
    captureOrder: Number(input.captureOrder ?? input.originalOrder ?? imageIndex),
    originalOrder: Number(input.originalOrder ?? input.captureOrder ?? imageIndex),
    role,
  };
}

function composeNormalDraft(draft: any) {
  const lots = Array.isArray(draft.lots) ? draft.lots : [];
  const lotIndexById = new Map<string, number>(
    lots.map((lot: any, index: number): [string, number] => [draftLotId(lot, index), index]),
  );
  const media = sortDraftMedia(draft.media || []);
  const mediaIds = new Set<string>();
  if (lotIndexById.size !== lots.length || media.some((item: any) => {
    const id = String(item.clientFileId || "");
    const invalid = !id || mediaIds.has(id) || !lotIndexById.has(String(item.lotId || "")) || !["main", "extra", "video"].includes(item.slot);
    mediaIds.add(id);
    return invalid;
  })) {
    throw Object.assign(new Error("The saved draft photo mapping is incomplete or inconsistent. Reopen the draft and review its lots. No photos were moved or removed."), { code: "INVALID_LOT_PHOTO_MAPPING", statusCode: 400 });
  }
  if (media.some((item: any) => !item.r2Key || !item.uploadedAt)) {
    throw Object.assign(new Error("Some saved originals are not yet confirmed. Reopen the draft and finish saving all photos before creating a preview."), { code: "DRAFT_MEDIA_UPLOAD_INCOMPLETE", statusCode: 409 });
  }
  // Worker counts consume contiguous main/extra slices. Match the restored
  // form's lot and slot order, not an interleaved legacy global manifest.
  const slotRank: Record<string, number> = { main: 0, extra: 1, video: 2 };
  media.sort((a: any, b: any) => lotIndexById.get(String(a.lotId))! - lotIndexById.get(String(b.lotId))! || slotRank[a.slot] - slotRank[b.slot]);
  const images: SerializedR2File[] = [];
  const videos: SerializedR2File[] = [];
  const counts: Array<Record<"main" | "extra" | "video", number>> = lots.map(() => ({
    main: 0,
    extra: 0,
    video: 0,
  }));

  media.forEach((item: any) => {
    const lotIndex = lotIndexById.get(String(item.lotId))!;
    const file = toR2File(item, lotIndex, images.length + videos.length);
    counts[lotIndex][file.role] += 1;
    if (file.role === "video") videos.push(file);
    else images.push({ ...file, imageIndex: images.length });
  });

  return {
    images,
    videos,
    mixedLots: counts.map((count, index) => ({
      count: count.main,
      extra_count: count.extra,
      video_count: count.video,
      cover_index: Number(lots[index]?.coverIndex || 0),
      mode: lots[index]?.mode || "single_lot",
    })),
  };
}

async function composeSmartDraft(draft: any) {
  const session = await ReportUploadSession.findOne({
    _id: draft.smartUploadSession,
    user: draft.user,
    smartUpload: true,
  }).lean();
  if (!session || session.smartGrouping?.status !== "confirmed") {
    throw Object.assign(new Error("Finish reviewing the Smart Upload groups before processing this draft."), {
      statusCode: 409,
    });
  }
  const filesById = new Map((session.files || []).map((file: any) => [String(file.fileId), file]));
  const dividerIds = new Set((session.smartGrouping?.dividerFileIds || []).map(String));
  const images: SerializedR2File[] = [];
  const mixedLots = (session.smartGrouping?.groups || []).map((group: any, lotIndex: number) => {
    const groupFiles = (group.fileIds || [])
      .map((id: unknown) => filesById.get(String(id)))
      .filter((file: any) => file?.uploadedAt && !dividerIds.has(String(file.fileId)));
    groupFiles.forEach((file: any) =>
      images.push(toR2File(file, lotIndex, images.length, session))
    );
    return {
      count: groupFiles.length,
      extra_count: 0,
      video_count: 0,
      cover_index: 0,
      mode: "single_lot",
    };
  });
  return { images, videos: [] as SerializedR2File[], mixedLots };
}

function draftPreviewJobType(type: "asset" | "lotListing") {
  return type === "asset" ? "asset-preview" : "lot-listing-preview";
}

function draftPreviewModel(type: "asset" | "lotListing"): any {
  return type === "asset" ? AssetReport : LotListing;
}

async function findDraftPreviewReport(input: {
  type: "asset" | "lotListing";
  userId: string;
  submissionId: string;
}) {
  return draftPreviewModel(input.type)
    .findOne({
      user: input.userId,
      client_submission_id: input.submissionId,
    })
    .select("+report_job_outbox")
    .lean();
}

async function findAcceptedDraftPreviewJob(input: {
  type: "asset" | "lotListing";
  reportId: string;
  jobId: string;
}) {
  return ReportJob.findOne({
    type: draftPreviewJobType(input.type),
    reportId: input.reportId,
    progressId: input.jobId,
    status: { $in: ["queued", "processing", "completed"] },
  })
    .sort({ createdAt: -1 })
    .lean();
}

async function ensureExistingDraftPreviewHandoff(input: {
  type: "asset" | "lotListing";
  draft: any;
}): Promise<boolean> {
  const reportId = String(input.draft?.previewReportId || "");
  const jobId = String(input.draft?.previewJobId || "");
  if (!reportId || !jobId) return false;
  const Model = draftPreviewModel(input.type);
  const report: any = await Model.findOne({
    _id: reportId,
    user: input.draft.user,
    job_id: jobId,
    is_draft_preview: true,
  })
    .select("+report_job_outbox")
    .lean();
  if (!report) return false;
  const token = String(report.report_job_outbox?.token || "");
  if (token) {
    const ensured = await ensureReportJobOutbox(
      input.type === "asset" ? "asset" : "lotListing",
      reportId,
      token
    );
    return Boolean(ensured);
  }
  return Boolean(
    await findAcceptedDraftPreviewJob({ type: input.type, reportId, jobId })
  );
}

type DraftPreviewReportMutation = {
  set: Record<string, unknown>;
  setOnInsert: Record<string, unknown>;
  unset?: Record<string, 1>;
};

type DraftPreviewReportHandoff = {
  report: any;
  queueInput: AssetJobInput | LotListingJobInput;
  outbox?: ReportJobOutbox;
  durableJob?: any;
};

/**
 * Persist the report state and exact queue payload in one document mutation.
 * Concurrent requests for the same deterministic draft revision converge on
 * the existing outbox/job; a different active revision is never overwritten.
 */
async function persistDraftPreviewReportHandoff(input: {
  type: "asset" | "lotListing";
  userId: string;
  submissionId: string;
  jobId: string;
  reportId: string;
  buildQueueInput: (reportId: string) => AssetJobInput | LotListingJobInput;
  buildMutation: (reportId: string) => DraftPreviewReportMutation;
}): Promise<DraftPreviewReportHandoff> {
  const Model = draftPreviewModel(input.type);
  let current: any = await findDraftPreviewReport(input);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reportId = String(current?._id || input.reportId);
    if (current && String(current._id) !== input.reportId) {
      throw Object.assign(
        new Error(
          "The draft preview report identity changed while processing was starting. Refresh and retry."
        ),
        { code: "DRAFT_PREVIEW_START_CONFLICT", statusCode: 409 }
      );
    }
    const queueInput = input.buildQueueInput(reportId);
    const sameLogicalJob =
      Boolean(current) && String(current.job_id || "") === input.jobId;
    const existingJob = current && sameLogicalJob
      ? await findAcceptedDraftPreviewJob({
          type: input.type,
          reportId,
          jobId: input.jobId,
        })
      : null;
    if (existingJob) {
      return { report: current, queueInput, durableJob: existingJob };
    }

    const currentOutboxToken = String(current?.report_job_outbox?.token || "");
    if (
      current &&
      sameLogicalJob &&
      currentOutboxToken
    ) {
      (queueInput as any).reportJobOutboxToken = currentOutboxToken;
      return {
        report: current,
        queueInput,
        outbox: current.report_job_outbox as ReportJobOutbox,
      };
    }

    if (
      current &&
      String(current.job_id || "") !== input.jobId &&
      ["uploading", "queued", "processing"].includes(
        String(current.job_status || "")
      )
    ) {
      throw Object.assign(
        new Error(
          "Another draft preview revision is still processing. Wait for it to finish before retrying."
        ),
        { code: "DRAFT_PREVIEW_REVISION_IN_PROGRESS", statusCode: 409 }
      );
    }

    const outbox = shouldUseMongoReportQueue()
      ? input.type === "asset"
        ? buildAssetPreviewJobOutbox(queueInput as AssetJobInput)
        : buildLotListingPreviewJobOutbox(queueInput as LotListingJobInput)
      : undefined;
    if (outbox) (queueInput as any).reportJobOutboxToken = outbox.token;
    const mutation = input.buildMutation(reportId);
    const set = {
      ...mutation.set,
      ...(outbox ? { report_job_outbox: outbox } : {}),
    };
    const unset = {
      ...(mutation.unset || {}),
      job_execution_token: 1 as const,
      ...(!outbox ? { report_job_outbox: 1 as const } : {}),
    };
    const filter = current
      ? {
          _id: current._id,
          user: input.userId,
          client_submission_id: input.submissionId,
          ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}),
          ...(sameLogicalJob
            ? {
                job_id: input.jobId,
                $or: [
                  { job_execution_token: { $exists: false } },
                  { job_execution_token: null },
                ],
              }
            : {
                job_status: { $nin: ["uploading", "queued", "processing"] },
              }),
        }
      : {
          _id: reportId,
          user: input.userId,
          client_submission_id: input.submissionId,
        };
    try {
      const persisted: any = await Model.findOneAndUpdate(
        filter,
        {
          $set: set,
          $setOnInsert: mutation.setOnInsert,
          $unset: unset,
        },
        {
          upsert: !current,
          new: true,
          setDefaultsOnInsert: true,
          runValidators: true,
        }
      )
        .select("+report_job_outbox")
        .lean();
      if (persisted) {
        return { report: persisted, queueInput, outbox };
      }
    } catch (error: any) {
      // The stable client submission key may be inserted by the concurrent
      // request between our read and upsert. Reload and converge below.
      if (Number(error?.code) !== 11000) throw error;
    }
    current = await findDraftPreviewReport(input);
  }

  throw Object.assign(
    new Error(
      "The draft preview changed while processing was starting. Refresh and retry."
    ),
    { code: "DRAFT_PREVIEW_START_CONFLICT", statusCode: 409 }
  );
}

/** Queues one explicit draft revision through the existing durable preview worker. */
export async function queueReportDraftPreview(draftId: string, userId: string) {
  if (!mongoose.isValidObjectId(draftId)) {
    throw Object.assign(new Error("Invalid draft id."), { statusCode: 400 });
  }
  const draft: any = await ReportDraft.findOne({
    _id: draftId,
    user: userId,
    promotedAt: null,
    promotionToken: null,
  });
  if (!draft) throw Object.assign(new Error("Draft not found."), { statusCode: 404 });

  const revision = Number(draft.revision || 0);
  if (
    draft.previewRequestedRevision === revision &&
    draft.previewStatus === "ready"
  ) {
    return toReportDraftClient(draft);
  }
  if (
    draft.previewRequestedRevision === revision &&
    ["queued", "processing"].includes(draft.previewStatus)
  ) {
    if (!shouldUseMongoReportQueue()) {
      return toReportDraftClient(draft);
    }
    try {
      if (await ensureExistingDraftPreviewHandoff({ type: draft.type, draft })) {
        return toReportDraftClient(draft);
      }
    } catch (error: any) {
      throw Object.assign(
        new Error(
          "The draft preview and its exact processing request are saved, but the worker handoff could not be confirmed. Retry this request."
        ),
        {
          code: "DRAFT_PREVIEW_QUEUE_HANDOFF_PENDING",
          statusCode: 503,
          cause: error,
        }
      );
    }
    // A pre-outbox crash may leave the deterministic revision marked queued
    // without either an embedded intent or a ReportJob. Rebuild that same
    // revision below; its stable report/job identities keep recovery idempotent.
  }
  if (
    ["queued", "processing"].includes(draft.previewStatus) &&
    draft.previewRequestedRevision !== revision
  ) {
    throw Object.assign(new Error("The previous draft revision is still processing. Please wait for it to finish."), {
      statusCode: 409,
    });
  }

  const duplicateLotConflicts = await findContractLotConflicts({
    contractNo: draft.contractNo || draft.formData?.contract_no,
    lots: Array.isArray(draft.lots) ? draft.lots : [],
    excludeDraftId: draft._id,
    excludeReportId: draft.previewReportId,
  });
  draft.duplicateLotConflicts = duplicateLotConflicts as any;
  await draft.save();
  if (duplicateLotConflicts.length) {
    // Autosave retains the work, but no draft may enter processing while its
    // explicit contract/lot identity is already reserved elsewhere.
    throw duplicateLotError(duplicateLotConflicts);
  }

  const user: any = await User.findById(userId).select("email name username").lean();
  if (!user) throw Object.assign(new Error("User not found."), { statusCode: 404 });
  const composed = draft.storageMode === "smart_upload"
    ? await composeSmartDraft(draft)
    : composeNormalDraft(draft);
  if (!composed.images.length) {
    throw Object.assign(new Error("Upload at least one draft image before creating a draft preview."), {
      statusCode: 400,
    });
  }
  assertMixedLotPhotoManifest(composed.mixedLots, composed.images.length);

  const now = new Date();
  const jobId = `draft-preview:${String(draft._id)}:r${revision}`;
  const submissionId = `draft-preview:${String(draft._id)}`;
  const formData = { ...(draft.formData || {}) };
  const contractNo = String(draft.contractNo || formData.contract_no || "Draft").trim();
  const details: any = {
    ...formData,
    contract_no: contractNo,
    grouping_mode: "mixed",
    mixed_lots: composed.mixedLots,
    client_submission_id: submissionId,
    upload_session_id: jobId,
    draft_preview: true,
    source_draft_id: String(draft._id),
    source_draft_revision: revision,
  };

  const existingPreviewReport: any = await findDraftPreviewReport({
    type: draft.type,
    userId,
    submissionId,
  });
  let reportId = String(
    existingPreviewReport?._id || new mongoose.Types.ObjectId()
  );
  // Establish the worker lifecycle guard before making the report outbox
  // visible to worker reconciliation. A crash here is recoverable from this
  // deterministic draft/job/report identity; the inverse ordering can let a
  // fast worker finish before the draft knows which revision it owns.
  let queuedDraft: any = await ReportDraft.findOneAndUpdate(
    {
      _id: draft._id,
      user: userId,
      revision,
      promotedAt: null,
      promotionToken: null,
      $or: [
        { previewRequestedRevision: { $ne: revision } },
        { previewStatus: { $nin: ["queued", "processing"] } },
      ],
    },
    {
      $set: {
        previewStatus: "queued",
        previewReportId: reportId,
        previewJobId: jobId,
        previewRequestedRevision: revision,
        previewRequestedAt: now,
      },
      $unset: { previewError: 1, previewReadyAt: 1 },
    },
    { new: true }
  );
  if (!queuedDraft) {
    queuedDraft = await ReportDraft.findOne({ _id: draft._id, user: userId });
    if (
      !queuedDraft ||
      Number(queuedDraft.previewRequestedRevision) !== revision ||
      String(queuedDraft.previewJobId || "") !== jobId ||
      !["queued", "processing", "ready"].includes(queuedDraft.previewStatus)
    ) {
      throw Object.assign(
        new Error(
          "The draft changed while preview processing was starting. Refresh and retry."
        ),
        { code: "DRAFT_PREVIEW_START_CONFLICT", statusCode: 409 }
      );
    }
    reportId = String(queuedDraft.previewReportId || "");
    if (!reportId) {
      throw Object.assign(
        new Error(
          "The queued draft preview is missing its report identity. Refresh and retry."
        ),
        { code: "DRAFT_PREVIEW_REPORT_ID_MISSING", statusCode: 409 }
      );
    }
  }

  const queueUser = {
    id: String(user._id),
    email: String(user.email || ""),
    name: user.name || user.username,
  };
  let handoff: DraftPreviewReportHandoff;
  if (draft.type === "asset") {
    handoff = await persistDraftPreviewReportHandoff({
      type: "asset",
      userId,
      submissionId,
      jobId,
      reportId,
      buildQueueInput: (reportId) => ({
        reportId,
        user: queueUser,
        images: composed.images as any,
        videos: composed.videos as any,
        details,
        progressId: jobId,
      }),
      buildMutation: () => ({
        set: {
          grouping_mode: "mixed",
          imageUrls: [], lots: [], status: "processing",
          job_id: jobId, job_status: "queued", queued_at: now,
          is_draft_preview: true, source_draft_id: draft._id, source_draft_revision: revision,
          contract_no: contractNo,
          client_name: formData.client_name,
          effective_date: formData.effective_date,
          appraisal_purpose: formData.appraisal_purpose,
          owner_name: formData.owner_name,
          appraiser: formData.appraiser,
          appraisal_company: formData.appraisal_company,
          industry: formData.industry,
          inspection_date: formData.inspection_date,
          language: formData.language || "en",
          currency: formData.currency || "CAD",
          preview_files: {}, files: {},
        },
        setOnInsert: { user: userId, client_submission_id: submissionId },
        unset: { job_error: 1, error_message: 1 },
      }),
    });
  } else {
    const salesDate = formData.sales_date ? new Date(formData.sales_date) : now;
    const normalizedSalesDate = Number.isNaN(salesDate.getTime()) ? now : salesDate;
    handoff = await persistDraftPreviewReportHandoff({
      type: "lotListing",
      userId,
      submissionId,
      jobId,
      reportId,
      buildQueueInput: (reportId) => ({
        listingId: reportId,
        user: queueUser,
        images: composed.images as any,
        videos: composed.videos as any,
        details: {
          ...details,
          sales_date: normalizedSalesDate.toISOString(),
          location: String(formData.location || "Draft location"),
        },
        progressId: jobId,
      }),
      buildMutation: () => ({
        set: {
          contract_no: contractNo,
          sales_date: normalizedSalesDate,
          location: String(formData.location || "Draft location"),
          imageUrls: [], lots: [], mixed_lots: composed.mixedLots,
          status: "processing", job_id: jobId, job_status: "queued", queued_at: now,
          is_draft_preview: true, source_draft_id: draft._id, source_draft_revision: revision,
          language: formData.language || "en", currency: formData.currency || "CAD",
          preview_files: {}, files: {},
        },
        setOnInsert: { user: userId, client_submission_id: submissionId },
        unset: { job_error: 1, error_message: 1 },
      }),
    });
  }
  const report = handoff.report;
  if (String(report._id) !== reportId) {
    throw Object.assign(
      new Error(
        "The draft preview report identity changed while processing was starting. Refresh and retry."
      ),
      { code: "DRAFT_PREVIEW_START_CONFLICT", statusCode: 409 }
    );
  }

  // Publish the revision guard before creating the worker job. A fast worker
  // can otherwise finish before the draft knows which job owns its lifecycle.
  if (!handoff.durableJob) try {
    if (draft.type === "asset") {
      await queueAssetPreviewJob(handoff.queueInput as AssetJobInput);
    } else {
      await queueLotListingJob(handoff.queueInput as LotListingJobInput);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (handoff.outbox) {
      let accepted: any = null;
      try {
        accepted = await findAcceptedDraftPreviewJob({
          type: draft.type,
          reportId: String(report._id),
          jobId,
        });
      } catch (lookupError) {
        console.error("[DraftPreview] ambiguous queue lookup failed", {
          draftId: String(draft._id),
          reportId: String(report._id),
          jobId,
          error:
            lookupError instanceof Error
              ? lookupError.message
              : String(lookupError),
        });
      }
      if (!accepted) {
        console.error("[DraftPreview] durable queue handoff pending", {
          draftId: String(draft._id),
          reportId: String(report._id),
          jobId,
          error: message,
        });
        throw Object.assign(
          new Error(
            "The draft preview and its exact processing request are saved, but the worker handoff could not be confirmed. Retry this request."
          ),
          {
            code: "DRAFT_PREVIEW_QUEUE_HANDOFF_PENDING",
            statusCode: 503,
            cause: error,
          }
        );
      }
    } else {
      await Promise.all([
        updateDraftPreviewLifecycle(String(draft._id), revision, jobId, {
          status: "error",
          reportId: String(report._id),
          error: message,
        }),
        draft.type === "asset"
          ? AssetReport.updateOne(
              { _id: report._id, is_draft_preview: true },
              {
                $set: { job_status: "error", job_error: message },
                $unset: { job_execution_token: 1 },
              },
            )
          : LotListing.updateOne(
              { _id: report._id, is_draft_preview: true },
              {
                $set: { job_status: "error", job_error: message },
                $unset: { job_execution_token: 1 },
              },
            ),
      ]);
      throw error;
    }
  }
  return toReportDraftClient(queuedDraft);
}

export async function deleteHiddenDraftPreview(draftId: unknown, userId: unknown) {
  await Promise.all([
    AssetReport.deleteMany({ source_draft_id: draftId, user: userId, is_draft_preview: true } as any),
    LotListing.deleteMany({ source_draft_id: draftId, user: userId, is_draft_preview: true } as any),
  ]);
}
