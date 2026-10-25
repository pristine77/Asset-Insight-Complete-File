/**
 * Smart-upload grouping state machine layered on a durable upload session.
 *
 * Detection produces a reviewable grouping rather than immediately generating a
 * report. Expected-state updates, manifest validation and deterministic ordering make
 * retries safe, while cancellation and cleanup release staged objects only after the
 * persisted session no longer permits further workflow progress.
 */
import { Response } from "express";
import { randomUUID } from "crypto";
import { AuthRequest } from "../middleware/auth.middleware.js";
import ReportUploadSession, {
  type ReportUploadSessionType,
} from "../models/reportUploadSession.model.js";
import {
  evaluateSmartUploadGrouping,
  getSmartUploadActiveInspectionErrors,
  SMART_UPLOAD_MAX_IMAGES_PER_LOT,
  SMART_UPLOAD_ALGORITHM_VERSION,
  sortSmartUploadFiles,
  validateSmartUploadGroups,
  validateSmartUploadOrderedFileIds,
} from "../service/smartUploadGroupingService.js";
import { getPositiveIntEnv, mapWithConcurrency } from "../utils/concurrency.js";
import { createMongoReportJob } from "../utils/reportJobMongoQueue.js";
import {
  deleteFromR2Strict,
  getR2PublicUrl,
  headR2Object,
  resolvePersistedR2StorageTarget,
} from "../utils/r2Storage/r2Upload.js";
import {
  issueSessionUploadTargets,
  LEGACY_UPLOAD_SESSION_READ_ONLY_CODE,
} from "./reportUploadSession.controller.js";
import {
  deleteReportDraftForSubmission,
  syncSmartUploadReportDraft,
} from "../service/reportDraftService.js";
import {
  resolveSmartUploadOrderReviewState,
  validateSmartUploadUnresolvedDividerIds,
} from "../utils/smartUploadReviewState.js";
import { applyReviewedGroupNumbers, isLotNumberUpload, LOT_NUMBER_UPLOAD_ALGORITHM_VERSION, lotNumberUploadWarnings, smartUploadGroupingMethod } from "../service/lotNumberUploadGrouping.js";

const TARGET_PAGE_MAX = 100;

async function findOwnedSmartSession(
  req: AuthRequest,
  type: ReportUploadSessionType
) {
  const session = await ReportUploadSession.findOne({
    _id: req.params.sessionId as any,
    type,
    user: req.userId as any,
    smartUpload: true,
  });
  return session;
}

function groupingPayload(session: any) {
  const grouping = session.smartGrouping || {};
  const storageTarget = resolvePersistedR2StorageTarget(session);
  const storedGroups = Array.isArray(grouping.groups) ? grouping.groups : [];
  const sortOptions = {
    preferOriginalOrder: ["manual", "groups"].includes(grouping.orderSource),
  };
  const files = sortSmartUploadFiles(
    (session.files || []).filter(
      (file: any) => file.fieldname === "images"
    ) as any[],
    sortOptions
  )
    .map((file: any, canonicalOrder: number) => ({
      fileId: String(file.fileId),
      name: String(file.originalname || "image"),
      mimeType: String(file.mimetype || "image/jpeg"),
      size: Number(file.verifiedSize || file.size || 0),
      url: getR2PublicUrl(String(file.key), storageTarget),
      // The client renders and submits this value. Expose canonical order,
      // not the picker/manifest order that may have been filename-sorted.
      originalOrder: canonicalOrder,
      captureTimestamp: Number.isFinite(Number(file.captureTimestamp))
        ? Number(file.captureTimestamp)
        : undefined,
      captureOrder: Number.isFinite(Number(file.captureOrder))
        ? Number(file.captureOrder)
        : undefined,
    }));
  const fileById = new Map(files.map((file: any) => [file.fileId, file]));
  const dividerFileIds = Array.isArray(grouping.dividerFileIds)
    ? grouping.dividerFileIds.map(String)
    : [];
  const orderReviewState = resolveSmartUploadOrderReviewState({
    orderReviewRequired: grouping.orderReviewRequired,
    unresolvedDividerIds: grouping.unresolvedDividerIds,
    dividerFileIds,
    detailsOrderAmbiguous: session.details?.smart_upload_order_ambiguous,
  });
  const canEvaluateGrouping = ["review_ready", "confirmed"].includes(
    String(grouping.status || "")
  );
  const evaluated = canEvaluateGrouping && !isLotNumberUpload(session)
    ? evaluateSmartUploadGrouping(
        session.files || [],
        dividerFileIds,
        SMART_UPLOAD_MAX_IMAGES_PER_LOT,
        sortOptions
      )
    : null;
  // Explicit reviewed groups can move a photo to a neighbouring lot without
  // changing divider membership. They are authoritative until the user edits
  // the divider-only contract again.
  const payloadGroups =
    grouping.orderSource === "groups" || isLotNumberUpload(session)
      ? storedGroups
      : evaluated?.groups || storedGroups;
  const activeInspectionErrors = getSmartUploadActiveInspectionErrors(
    grouping.metrics,
    dividerFileIds
  );
  const inspectionWarningMessages = activeInspectionErrors.map(
    ({ fileId, error }) => `Could not inspect ${fileId}: ${error}`
  );
  const warnings = isLotNumberUpload(session) && canEvaluateGrouping
    ? [...inspectionWarningMessages, ...lotNumberUploadWarnings(storedGroups)]
    : evaluated
    ? Array.from(
        new Set([
          ...inspectionWarningMessages,
          ...(grouping.orderSource === "groups" ? [] : evaluated.warnings),
        ])
      )
    : Array.isArray(grouping.warnings)
      ? grouping.warnings
      : [];
  return {
    sessionId: String(session._id),
    smartUpload: true,
    groupingMethod: smartUploadGroupingMethod(session),
    groupingStatus: grouping.status || "uploading",
    progressPercent: grouping.progressPercent || 0,
    revision: Number.isFinite(Number(grouping.revision))
      ? Number(grouping.revision)
      : 0,
    orderReviewRequired: orderReviewState.orderReviewRequired,
    unresolvedDividerIds: orderReviewState.unresolvedDividerIds,
    unresolvedLotNumberFileIds: grouping.unresolvedLotNumberFileIds || [],
    lotStartFileIds: isLotNumberUpload(session) ? storedGroups.map((group: any) => group.fileIds?.[0]).filter(Boolean) : [],
    algorithmVersion:
      grouping.algorithmVersion || (isLotNumberUpload(session) ? LOT_NUMBER_UPLOAD_ALGORITHM_VERSION : SMART_UPLOAD_ALGORITHM_VERSION),
    classificationJobId: grouping.classificationJobId,
    orderSource: grouping.orderSource,
    files,
    groups: payloadGroups.map((group: any) => ({
      ...(typeof group.toObject === "function" ? group.toObject() : group),
      files: (group.fileIds || [])
        .map((fileId: unknown) => fileById.get(String(fileId)))
        .filter(Boolean),
    })),
    dividerFileIds,
    metrics: grouping.metrics || [],
    inspectionErrors: activeInspectionErrors,
    warnings,
    error: grouping.error,
    expectedFileCount: session.expectedFileCount,
    confirmedFileCount: session.files.filter((file: any) => file.uploadedAt)
      .length,
  };
}

export function getSmartUploadTargets(type: ReportUploadSessionType) {
  return async (req: AuthRequest, res: Response) => {
    try {
      const session = await findOwnedSmartSession(req, type);
      if (!session) {
        return res.status(404).json({ message: "Smart Upload session not found." });
      }
      if (["completed", "queued", "processed"].includes(session.status)) {
        return res.status(409).json({
          code: "SMART_UPLOAD_SESSION_LOCKED",
          message: "This Smart Upload session has already been submitted.",
        });
      }
      if (session.cleanupStartedAt) {
        return res.status(409).json({
          code: "SMART_UPLOAD_SESSION_CLEANUP_STARTED",
          message: "This expired Smart Upload is being cleaned up and cannot be resumed.",
        });
      }
      if (String(session.smartGrouping?.status || "uploading") !== "uploading") {
        return res.status(409).json({
          code: "SMART_UPLOAD_FILES_LOCKED",
          message:
            "Upload files are locked after divider detection starts. Continue from the lot review.",
        });
      }
      if (
        resolvePersistedR2StorageTarget(session).generation !== "current"
      ) {
        return res.status(409).json({
          code: LEGACY_UPLOAD_SESSION_READ_ONLY_CODE,
          message:
            "This upload session predates the storage migration and is read-only. Start a new submission; existing uploaded files remain intact.",
        });
      }

      const cursor = Math.max(0, Number.parseInt(String(req.query.cursor || "0"), 10) || 0);
      const limit = Math.max(
        1,
        Math.min(
          TARGET_PAGE_MAX,
          Number.parseInt(String(req.query.limit || TARGET_PAGE_MAX), 10) ||
            TARGET_PAGE_MAX
        )
      );
      const files = await issueSessionUploadTargets(session, cursor, limit);
      const next = cursor + files.length;
      return res.status(200).json({
        data: {
          files,
          cursor,
          nextCursor: next < session.files.length ? String(next) : null,
          total: session.files.length,
        },
      });
    } catch (error) {
      console.error("[SmartUpload] target page failed:", error);
      return res.status(500).json({
        message: "Unable to prepare the next upload batch.",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export function confirmSmartUploadFiles(type: ReportUploadSessionType) {
  return async (req: AuthRequest, res: Response) => {
    try {
      const session = await findOwnedSmartSession(req, type);
      if (!session) {
        return res.status(404).json({ message: "Smart Upload session not found." });
      }
      if (["completed", "queued", "processed"].includes(session.status)) {
        return res.status(409).json({
          code: "SMART_UPLOAD_SESSION_LOCKED",
          message: "This Smart Upload session has already been submitted.",
        });
      }
      if (session.cleanupStartedAt) {
        return res.status(409).json({
          code: "SMART_UPLOAD_SESSION_CLEANUP_STARTED",
          message: "This expired Smart Upload is being cleaned up and cannot be resumed.",
        });
      }
      if (String(session.smartGrouping?.status || "uploading") !== "uploading") {
        return res.status(409).json({
          code: "SMART_UPLOAD_FILES_LOCKED",
          message:
            "Uploaded files cannot be changed after divider detection starts.",
        });
      }
      const requested = new Set(
        (Array.isArray(req.body?.fileIds) ? req.body.fileIds : []).map(String)
      );
      if (!requested.size) {
        return res.status(400).json({ message: "Select uploaded files to confirm." });
      }
      const files = (session.files as any[]).filter((file) =>
        requested.has(String(file.fileId))
      );
      if (files.length !== requested.size) {
        return res.status(400).json({
          message: "One or more upload files do not belong to this session.",
        });
      }

      const storageTarget = resolvePersistedR2StorageTarget(session);
      const bucketName = storageTarget.bucketName;
      const concurrency = getPositiveIntEnv("SMART_UPLOAD_CONFIRM_CONCURRENCY", 8);
      const missing: string[] = [];
      const sizeMismatches: Array<{
        fileId: string;
        expectedBytes: number;
        actualBytes: number;
      }> = [];
      await mapWithConcurrency(files, concurrency, async (file) => {
        try {
          const head = await headR2Object(bucketName, String(file.key));
          const expectedBytes = Number(file.size || 0);
          const actualBytes = Number(head.size || 0);
          if (
            !Number.isSafeInteger(expectedBytes) ||
            expectedBytes <= 0 ||
            !Number.isSafeInteger(actualBytes) ||
            actualBytes !== expectedBytes
          ) {
            file.uploadedAt = undefined;
            file.verifiedSize = undefined;
            sizeMismatches.push({
              fileId: String(file.fileId),
              expectedBytes,
              actualBytes,
            });
            return;
          }
          file.uploadedAt = new Date();
          file.verifiedSize = actualBytes;
        } catch {
          file.uploadedAt = undefined;
          file.verifiedSize = undefined;
          missing.push(String(file.fileId));
        }
      });
      session.markModified("files");
      const saved = await ReportUploadSession.findOneAndUpdate(
        {
          _id: session._id,
          type,
          user: req.userId as any,
          status: { $nin: ["completed", "queued", "processed"] },
          cleanupStartedAt: { $exists: false },
          "smartGrouping.status": { $in: ["uploading", null] },
          updatedAt: (session as any).updatedAt,
        },
        { $set: { files: session.files } },
        { new: true, runValidators: true }
      );
      if (!saved) {
        return res.status(409).json({
          code: "SMART_UPLOAD_SESSION_LOCKED",
          message:
            "This Smart Upload changed or was submitted while files were being verified. Refresh before continuing.",
        });
      }
      try {
        await syncSmartUploadReportDraft(saved);
      } catch (error) {
        console.error(
          "[SmartUpload] file-confirm draft projection failed; upload session remains authoritative",
          {
            sessionId: String(saved._id),
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }

      if (missing.length || sizeMismatches.length) {
        return res.status(409).json({
          code: sizeMismatches.length
            ? "UPLOAD_FILE_SIZE_MISMATCH"
            : "UPLOAD_NOT_VERIFIED",
          message: `${missing.length + sizeMismatches.length} uploaded image(s) could not be verified. Retry only those images.`,
          missingFileIds: missing,
          sizeMismatches,
        });
      }
      return res.status(200).json({
        data: {
          confirmedFileIds: files.map((file) => String(file.fileId)),
          confirmedFileCount: saved.files.filter((file) => file.uploadedAt)
            .length,
          expectedFileCount: session.expectedFileCount,
        },
      });
    } catch (error) {
      console.error("[SmartUpload] confirm files failed:", error);
      return res.status(500).json({
        message: "Unable to confirm uploaded images.",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export function startSmartUploadDetection(type: ReportUploadSessionType) {
  return async (req: AuthRequest, res: Response) => {
    try {
      const session = await findOwnedSmartSession(req, type);
      if (!session) {
        return res.status(404).json({ message: "Smart Upload session not found." });
      }
      if (["completed", "queued", "processed"].includes(session.status)) {
        return res.status(409).json({
          code: "SMART_UPLOAD_SESSION_LOCKED",
          message: "This Smart Upload has already been submitted.",
        });
      }
      if (session.cleanupStartedAt) {
        return res.status(409).json({
          code: "SMART_UPLOAD_SESSION_CLEANUP_STARTED",
          message: "This expired Smart Upload is being cleaned up and cannot be resumed.",
        });
      }
      const unconfirmed = session.files.filter((file) => !file.uploadedAt);
      if (unconfirmed.length) {
        return res.status(409).json({
          message: `${unconfirmed.length} image(s) still need to finish uploading.`,
          missingFileIds: unconfirmed.map((file) => file.fileId),
        });
      }
      if (
        session.smartGrouping?.status === "review_ready" ||
        session.smartGrouping?.status === "confirmed"
      ) {
        return res.status(200).json({ data: groupingPayload(session) });
      }
      if (session.smartGrouping?.status === "classifying") {
        return res.status(202).json({ data: groupingPayload(session) });
      }

      const progressId = `smart-upload:${String(session._id)}`;
      const classificationJobId = randomUUID();
      const expectedRevision = Number.isFinite(
        Number(session.smartGrouping?.revision)
      )
        ? Number(session.smartGrouping?.revision)
        : 0;
      const job = await createMongoReportJob({
        type: "smart-upload-classify",
        progressId,
        idempotencyKey: `smart-upload-classify:${String(session._id)}:${session.manifestHash}:${classificationJobId}`,
        payload: {
          sessionId: String(session._id),
          progressId,
          classificationJobId,
          classificationRevision: expectedRevision,
        },
        maxAttempts: 3,
      });
      if (!job) throw new Error("Unable to create the Smart Upload classification job");
      const orderReviewState = resolveSmartUploadOrderReviewState({
        orderReviewRequired: session.smartGrouping?.orderReviewRequired,
        unresolvedDividerIds: session.smartGrouping?.unresolvedDividerIds,
        dividerFileIds: session.smartGrouping?.dividerFileIds || [],
        detailsOrderAmbiguous:
          session.details?.smart_upload_order_ambiguous,
      });
      const revisionFilter =
        expectedRevision === 0
          ? {
              $or: [
                { "smartGrouping.revision": 0 },
                { "smartGrouping.revision": { $exists: false } },
                { "smartGrouping.revision": null },
              ],
            }
          : { "smartGrouping.revision": expectedRevision };
      const claimed = await ReportUploadSession.findOneAndUpdate(
        {
          _id: session._id,
          type,
          user: req.userId as any,
          smartUpload: true,
          status: { $nin: ["completed", "queued", "processed"] },
          cleanupStartedAt: { $exists: false },
          "smartGrouping.status": { $in: ["uploading", "failed", null] },
          updatedAt: (session as any).updatedAt,
          ...revisionFilter,
        },
        {
          $set: {
            smartGrouping: {
              method: smartUploadGroupingMethod(session),
              status: "classifying",
              progressPercent: 0,
              revision: expectedRevision,
              algorithmVersion: isLotNumberUpload(session) ? LOT_NUMBER_UPLOAD_ALGORITHM_VERSION : SMART_UPLOAD_ALGORITHM_VERSION,
              classificationJobId,
              orderReviewRequired: orderReviewState.orderReviewRequired,
              unresolvedDividerIds: [],
              unresolvedLotNumberFileIds: [],
              dividerFileIds: [],
              groups: [],
              warnings: [],
              metrics: isLotNumberUpload(session) ? session.smartGrouping?.metrics || [] : [],
            },
          },
        },
        { new: true, runValidators: true }
      );
      if (!claimed) {
        const latest = await findOwnedSmartSession(req, type);
        if (!latest) {
          return res.status(404).json({ message: "Smart Upload session not found." });
        }
        if (["completed", "queued", "processed"].includes(latest.status)) {
          return res.status(409).json({
            code: "SMART_UPLOAD_SESSION_LOCKED",
            message: "This Smart Upload has already been submitted.",
          });
        }
        if (latest.cleanupStartedAt) {
          return res.status(409).json({
            code: "SMART_UPLOAD_SESSION_CLEANUP_STARTED",
            message:
              "This expired Smart Upload is being cleaned up and cannot be resumed.",
          });
        }
        const ready = ["review_ready", "confirmed"].includes(
          latest.smartGrouping?.status || ""
        );
        if (ready) {
          return res.status(200).json({ data: groupingPayload(latest) });
        }
        if (latest.smartGrouping?.status === "classifying") {
          return res.status(202).json({ data: groupingPayload(latest) });
        }
        return res.status(409).json({
          code: "SMART_UPLOAD_CLASSIFICATION_START_STALE",
          message:
            "Smart Upload changed while detection was starting. Retry detection from the latest upload state.",
          data: groupingPayload(latest),
        });
      }
      try {
        await syncSmartUploadReportDraft(claimed);
      } catch (error) {
        console.error(
          "[SmartUpload] classification-start draft projection failed; upload session remains authoritative",
          {
            sessionId: String(claimed._id),
            classificationJobId,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
      return res.status(202).json({ data: groupingPayload(claimed) });
    } catch (error) {
      console.error("[SmartUpload] classification queue failed:", error);
      return res.status(500).json({
        message: "Unable to start image detection.",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export function getSmartUploadGrouping(type: ReportUploadSessionType) {
  return async (req: AuthRequest, res: Response) => {
    const session = await findOwnedSmartSession(req, type);
    if (!session) {
      return res.status(404).json({ message: "Smart Upload session not found." });
    }
    if (session.cleanupStartedAt) {
      return res.status(409).json({
        code: "SMART_UPLOAD_SESSION_CLEANUP_STARTED",
        message:
          "This expired Smart Upload is being cleaned up and cannot be resumed.",
      });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ data: groupingPayload(session) });
  };
}

async function updateLotNumberGrouping(req: AuthRequest, res: Response, session: any, type: ReportUploadSessionType, revision: number) {
  const body = req.body || {};
  if (body.revision === undefined) return res.status(400).json({ code: "SMART_UPLOAD_GROUPING_REVISION_REQUIRED", message: "Refresh the upload review before saving." });
  if ((body.groupingMethod !== undefined && body.groupingMethod !== "lot_number") ||
      (body.dividerFileIds !== undefined && (!Array.isArray(body.dividerFileIds) || body.dividerFileIds.length))) {
    return res.status(400).json({ code: "INVALID_LOT_NUMBER_GROUPING", message: "Lot-number photos stay in their lots. This upload method cannot exclude divider photos." });
  }
  if (body.acknowledgeLotNumberReview !== undefined && typeof body.acknowledgeLotNumberReview !== "boolean") {
    return res.status(400).json({ message: "Lot-number review acknowledgement must be true or false." });
  }
  if (body.confirm === true && body.acknowledgeLotNumberReview !== true) {
    return res.status(409).json({ code: "LOT_NUMBER_UPLOAD_REVIEW_REQUIRED", message: "Confirm that you reviewed the lot boundaries and numbers before creating the preview." });
  }
  if (body.orderReviewRequired !== undefined && typeof body.orderReviewRequired !== "boolean") {
    return res.status(400).json({ message: "Order review state must be true or false." });
  }
  const hasGroups = Object.prototype.hasOwnProperty.call(body, "groups");
  const rawGroups = hasGroups ? body.groups : session.smartGrouping?.groups || [];
  if (!Array.isArray(rawGroups)) return res.status(400).json({ message: "Provide the complete reviewed lot groups." });
  const validation = validateSmartUploadGroups(session.files, [], rawGroups, SMART_UPLOAD_MAX_IMAGES_PER_LOT);
  const validManifest = rawGroups.length > 0 && !validation.emptyGroupIndexes.length && !validation.duplicateFileIds.length &&
    !validation.missingFileIds.length && !validation.unknownFileIds.length && !validation.dividerFileIdsInGroups.length;
  // Oversized auto-detected groups must stay editable so a missed marker can
  // be repaired one split at a time; only confirmation enforces the lot limit.
  if (!validManifest) return res.status(400).json({ code: "INVALID_SMART_UPLOAD_GROUPS",
    message: "Every uploaded photo must appear in exactly one non-empty lot, with 200 photos or fewer per lot.", data: validation });
  const groups = applyReviewedGroupNumbers(validation.groups, rawGroups);
  const orderedIds = groups.flatMap((group) => group.fileIds);
  if (body.orderedFileIds !== undefined) {
    const order = Array.isArray(body.orderedFileIds) ? validateSmartUploadOrderedFileIds(session.files, body.orderedFileIds) : null;
    if (!order?.valid || order.orderedFileIds.some((id, index) => id !== orderedIds[index])) return res.status(400).json({
      code: "INVALID_SMART_UPLOAD_ORDER", message: "Image order must match the complete reviewed lot order." });
  }
  let unresolved = (session.smartGrouping?.unresolvedLotNumberFileIds || []).map(String) as string[];
  if (body.resolveLotNumberFileIds !== undefined) {
    const requested = body.resolveLotNumberFileIds;
    if (!Array.isArray(requested) || requested.some((id) => typeof id !== "string" || !unresolved.includes(id)) || new Set(requested).size !== requested.length) {
      return res.status(400).json({ message: "Only uncertain photos in this review can be marked reviewed." });
    }
    const resolved = new Set(requested);
    unresolved = unresolved.filter((id) => !resolved.has(id));
  }
  if (body.acknowledgeLotNumberReview === true) unresolved = [];
  const orderReviewRequired = body.orderReviewRequired ?? Boolean(session.smartGrouping?.orderReviewRequired);
  const inspectionErrors = getSmartUploadActiveInspectionErrors(session.smartGrouping?.metrics, []);
  const warnings = [...inspectionErrors.map(({ error }) => error), ...lotNumberUploadWarnings(groups)];
  if (body.confirm === true && (unresolved.length || orderReviewRequired)) return res.status(409).json({
    code: "LOT_NUMBER_UPLOAD_REVIEW_REQUIRED", message: "Review the image order and uncertain lot-number photos before confirming.",
    data: { unresolvedLotNumberFileIds: unresolved, orderReviewRequired } });
  if (body.confirm === true && warnings.length) return res.status(400).json({
    code: "INVALID_LOT_NUMBER_GROUPING", message: warnings[0], data: { groups, warnings } });
  const orderById = new Map(orderedIds.map((id, index) => [id, index]));
  const files = session.files.map((file: any) => ({ ...(typeof file.toObject === "function" ? file.toObject() : file), originalOrder: orderById.get(String(file.fileId)) }));
  const updated = await ReportUploadSession.findOneAndUpdate({ _id: session._id, type, user: req.userId as any,
    smartUpload: true, "smartGrouping.method": "lot_number", "smartGrouping.revision": revision,
    "smartGrouping.status": { $in: ["review_ready", "confirmed"] }, status: { $nin: ["completed", "queued", "processed"] },
    cleanupStartedAt: { $exists: false },
  }, { $set: { files, smartGrouping: { ...(typeof session.smartGrouping?.toObject === "function" ? session.smartGrouping.toObject() : session.smartGrouping),
    method: "lot_number", status: body.confirm === true ? "confirmed" : "review_ready", revision: revision + 1,
    algorithmVersion: LOT_NUMBER_UPLOAD_ALGORITHM_VERSION, orderSource: "groups", orderReviewRequired,
    dividerFileIds: [], unresolvedDividerIds: [], unresolvedLotNumberFileIds: unresolved, groups, warnings,
    ...(body.confirm === true ? { confirmedAt: new Date() } : {}),
  } } }, { new: true, runValidators: true });
  if (!updated) return res.status(409).json({ code: "SMART_UPLOAD_GROUPING_STALE", message: "This upload changed in another tab. Refresh the review." });
  try { await syncSmartUploadReportDraft(updated); }
  catch { console.error("[LotNumberUpload] Draft projection needs retry; reviewed grouping remains committed", { sessionId: String(updated._id) }); }
  return res.status(200).json({ data: groupingPayload(updated) });
}

export function updateSmartUploadGrouping(type: ReportUploadSessionType) {
  return async (req: AuthRequest, res: Response) => {
    try {
      const session = await findOwnedSmartSession(req, type);
      if (!session) {
        return res.status(404).json({ message: "Smart Upload session not found." });
      }
      if (["completed", "queued", "processed"].includes(session.status)) {
        return res.status(409).json({
          code: "SMART_UPLOAD_GROUPING_LOCKED",
          message:
            "This Smart Upload has already started creating its report and can no longer be edited.",
        });
      }
      if (session.cleanupStartedAt) {
        return res.status(409).json({
          code: "SMART_UPLOAD_SESSION_CLEANUP_STARTED",
          message:
            "This expired Smart Upload is being cleaned up and cannot be edited.",
        });
      }
      if (!["review_ready", "confirmed"].includes(session.smartGrouping?.status || "")) {
        return res.status(409).json({
          message: "Wait for black-image detection to finish before editing dividers.",
        });
      }

      const currentRevision = Number.isFinite(
        Number(session.smartGrouping?.revision)
      )
        ? Number(session.smartGrouping?.revision)
        : 0;
      if (req.body?.revision !== undefined) {
        const requestedRevision = Number(req.body.revision);
        if (
          !Number.isInteger(requestedRevision) ||
          requestedRevision < 0 ||
          requestedRevision !== currentRevision
        ) {
          return res.status(409).json({
            code: "SMART_UPLOAD_GROUPING_STALE",
            message:
              "This Smart Upload was changed in another tab. Refresh the review before saving again.",
            data: { revision: currentRevision },
          });
        }
      }

      if (isLotNumberUpload(session)) {
        return updateLotNumberGrouping(req, res, session, type, currentRevision);
      }

      const imageFiles = session.files.filter(
        (file) => file.fieldname === "images"
      );
      const validIds = new Set(imageFiles.map((file) => String(file.fileId)));
      const hasOrderedFileIds = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "orderedFileIds"
      );
      let orderSource = session.smartGrouping?.orderSource;
      if (hasOrderedFileIds) {
        if (!Array.isArray(req.body?.orderedFileIds)) {
          return res.status(400).json({
            code: "INVALID_SMART_UPLOAD_ORDER",
            message: "The reviewed image order must be a complete list.",
          });
        }
        const orderValidation = validateSmartUploadOrderedFileIds(
          session.files as any,
          req.body.orderedFileIds
        );
        if (!orderValidation.valid) {
          return res.status(400).json({
            code: "INVALID_SMART_UPLOAD_ORDER",
            message:
              "The reviewed image order must contain every uploaded image exactly once.",
            data: {
              duplicateFileIds: orderValidation.duplicateFileIds,
              missingFileIds: orderValidation.missingFileIds,
              unknownFileIds: orderValidation.unknownFileIds,
            },
          });
        }
        const orderByFileId = new Map(
          orderValidation.orderedFileIds.map((fileId, index) => [fileId, index])
        );
        for (const file of imageFiles) {
          file.originalOrder = orderByFileId.get(String(file.fileId))!;
        }
        orderSource = "manual";
        session.markModified("files");
      }
      const hasDividerFileIds = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "dividerFileIds"
      );
      if (hasDividerFileIds && !Array.isArray(req.body?.dividerFileIds)) {
        return res.status(400).json({
          code: "INVALID_SMART_UPLOAD_DIVIDERS",
          message: "dividerFileIds must be a list of uploaded image IDs.",
        });
      }
      const dividerFileIds: string[] = Array.from(
        new Set<string>(
          (hasDividerFileIds
            ? req.body.dividerFileIds
            : session.smartGrouping?.dividerFileIds || []
          ).map((value: unknown) => String(value))
        )
      );
      if (dividerFileIds.some((fileId) => !validIds.has(fileId))) {
        return res.status(400).json({
          message: "A selected divider does not belong to this upload.",
        });
      }
      const inspectionErrors = getSmartUploadActiveInspectionErrors(
        session.smartGrouping?.metrics,
        dividerFileIds
      );
      const inspectionWarnings = inspectionErrors.map(
        ({ fileId, error }) => `Could not inspect ${fileId}: ${error}`
      );

      const previousDividerFileIds = Array.isArray(
        session.smartGrouping?.dividerFileIds
      )
        ? (session.smartGrouping?.dividerFileIds || []).map(String)
        : [];
      const currentOrderReviewState = resolveSmartUploadOrderReviewState({
        orderReviewRequired: session.smartGrouping?.orderReviewRequired,
        unresolvedDividerIds: session.smartGrouping?.unresolvedDividerIds,
        dividerFileIds: previousDividerFileIds,
        detailsOrderAmbiguous:
          session.details?.smart_upload_order_ambiguous,
      });
      const hasOrderReviewRequired = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "orderReviewRequired"
      );
      if (
        hasOrderReviewRequired &&
        typeof req.body?.orderReviewRequired !== "boolean"
      ) {
        return res.status(400).json({
          code: "INVALID_SMART_UPLOAD_REVIEW_STATE",
          message: "orderReviewRequired must be true or false.",
        });
      }
      let orderReviewRequired = hasOrderReviewRequired
        ? req.body.orderReviewRequired
        : currentOrderReviewState.orderReviewRequired;
      const hasUnresolvedDividerIds = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "unresolvedDividerIds"
      );
      if (
        hasUnresolvedDividerIds &&
        !Array.isArray(req.body?.unresolvedDividerIds)
      ) {
        return res.status(400).json({
          code: "INVALID_SMART_UPLOAD_REVIEW_STATE",
          message: "unresolvedDividerIds must be a list of divider image IDs.",
        });
      }
      let unresolvedDividerIds: string[];
      if (hasUnresolvedDividerIds) {
        const reviewValidation = validateSmartUploadUnresolvedDividerIds(
          dividerFileIds,
          req.body.unresolvedDividerIds
        );
        if (!reviewValidation.valid) {
          return res.status(400).json({
            code: "INVALID_SMART_UPLOAD_REVIEW_STATE",
            message:
              "Each unresolved divider must be a current divider image and may appear only once.",
            data: {
              duplicateFileIds: reviewValidation.duplicateFileIds,
              emptyFileIds: reviewValidation.emptyFileIds,
              nonDividerFileIds: reviewValidation.nonDividerFileIds,
            },
          });
        }
        unresolvedDividerIds = reviewValidation.unresolvedDividerIds;
      } else {
        const nextDividerSet = new Set(dividerFileIds);
        unresolvedDividerIds = currentOrderReviewState.unresolvedDividerIds.filter(
          (fileId) => nextDividerSet.has(fileId)
        );
        const previousDividerSet = new Set(previousDividerFileIds);
        if (
          orderReviewRequired &&
          ((!currentOrderReviewState.orderReviewRequired &&
            hasOrderReviewRequired) ||
            dividerFileIds.some((fileId) => !previousDividerSet.has(fileId)))
        ) {
          unresolvedDividerIds = Array.from(
            new Set([
              ...unresolvedDividerIds,
              ...dividerFileIds.filter(
                (fileId) =>
                  (!currentOrderReviewState.orderReviewRequired &&
                    hasOrderReviewRequired) ||
                  !previousDividerSet.has(fileId)
              ),
            ])
          );
        }
      }
      if (unresolvedDividerIds.length > 0 && !orderReviewRequired) {
        if (hasOrderReviewRequired) {
          return res.status(400).json({
            code: "INVALID_SMART_UPLOAD_REVIEW_STATE",
            message:
              "orderReviewRequired cannot be false while divider reviews remain unresolved.",
          });
        }
        orderReviewRequired = true;
      }

      const hasAuthoritativeGroups = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "groups"
      );
      let groups: ReturnType<typeof validateSmartUploadGroups>["groups"];
      let warnings: string[];
      if (hasAuthoritativeGroups) {
        if (!Array.isArray(req.body?.groups)) {
          return res.status(400).json({
            code: "INVALID_SMART_UPLOAD_GROUPS",
            message: "The reviewed lots must be a complete list of groups.",
          });
        }
        const groupValidation = validateSmartUploadGroups(
          session.files as any,
          dividerFileIds,
          req.body.groups,
          SMART_UPLOAD_MAX_IMAGES_PER_LOT
        );
        if (!groupValidation.valid) {
          return res.status(400).json({
            code: "INVALID_SMART_UPLOAD_GROUPS",
            message:
              "Every non-divider image must appear in exactly one non-empty lot, with no divider images included.",
            data: {
              duplicateFileIds: groupValidation.duplicateFileIds,
              missingFileIds: groupValidation.missingFileIds,
              unknownFileIds: groupValidation.unknownFileIds,
              dividerFileIdsInGroups:
                groupValidation.dividerFileIdsInGroups,
              emptyGroupIndexes: groupValidation.emptyGroupIndexes,
              overLimitGroupIndexes: groupValidation.overLimitGroupIndexes,
            },
          });
        }
        groups = groupValidation.groups;
        warnings = [...inspectionWarnings];
        orderSource = "groups";

        // Persist a total deterministic order as well. Divider positions are
        // retained from the current canonical sequence, while non-divider
        // photos follow the reviewed group sequence.
        const existingDividerFiles = sortSmartUploadFiles(
          imageFiles as any,
          {
            preferOriginalOrder: ["manual", "groups"].includes(
              session.smartGrouping?.orderSource || ""
            ),
          }
        ).filter((file: any) => dividerFileIds.includes(String(file.fileId)));
        const flattenedGroupIds = groups.flatMap((group) => group.fileIds);
        const reviewedOrder = [...flattenedGroupIds];
        existingDividerFiles.forEach((file: any, index: number) => {
          const afterGroup = Math.min(index + 1, groups.length);
          const insertAt = groups
            .slice(0, afterGroup)
            .reduce((sum, group) => sum + group.fileIds.length, 0) + index;
          reviewedOrder.splice(insertAt, 0, String(file.fileId));
        });
        const orderByFileId = new Map(
          reviewedOrder.map((fileId, index) => [fileId, index])
        );
        for (const file of imageFiles) {
          file.originalOrder = orderByFileId.get(String(file.fileId))!;
        }
        session.markModified("files");
      } else {
        if (
          orderSource === "groups" &&
          (hasDividerFileIds || hasOrderedFileIds)
        ) {
          // Supplying divider/order fields without explicit groups switches
          // back to the divider-derived compatibility contract while keeping
          // the last reviewed sequence as the authoritative order.
          orderSource = "manual";
        }
        if (orderSource === "groups") {
          // A confirmation or review-state-only PATCH must not discard an
          // authoritative arrangement created by Move previous/next controls.
          const persistedValidation = validateSmartUploadGroups(
            session.files as any,
            dividerFileIds,
            session.smartGrouping?.groups || [],
            SMART_UPLOAD_MAX_IMAGES_PER_LOT
          );
          if (!persistedValidation.valid) {
            return res.status(409).json({
              code: "INVALID_SMART_UPLOAD_GROUPS",
              message:
                "The saved lot arrangement is no longer valid. Refresh the review and save the lots again.",
              data: {
                duplicateFileIds: persistedValidation.duplicateFileIds,
                missingFileIds: persistedValidation.missingFileIds,
                unknownFileIds: persistedValidation.unknownFileIds,
                dividerFileIdsInGroups:
                  persistedValidation.dividerFileIdsInGroups,
                emptyGroupIndexes: persistedValidation.emptyGroupIndexes,
                overLimitGroupIndexes:
                  persistedValidation.overLimitGroupIndexes,
              },
            });
          }
          groups = persistedValidation.groups;
          warnings = [...inspectionWarnings];
        } else {
          const preferOriginalOrder = orderSource === "manual";
          const evaluated = evaluateSmartUploadGrouping(
            session.files as any,
            dividerFileIds,
            SMART_UPLOAD_MAX_IMAGES_PER_LOT,
            { preferOriginalOrder }
          );
          groups = evaluated.groups;
          warnings = Array.from(
            new Set([...inspectionWarnings, ...evaluated.warnings])
          );
        }
      }
      const confirm = req.body?.confirm === true;
      if (
        confirm &&
        (orderReviewRequired || unresolvedDividerIds.length > 0)
      ) {
        return res.status(409).json({
          code: "SMART_UPLOAD_ORDER_REVIEW_REQUIRED",
          message:
            "Finish reviewing the image order and every unresolved divider before confirming these lots.",
          data: {
            orderReviewRequired,
            unresolvedDividerIds,
            groups,
            dividerFileIds,
          },
        });
      }
      if (confirm && inspectionErrors.length) {
        return res.status(409).json({
          code: "SMART_UPLOAD_IMAGE_INSPECTION_FAILED",
          message:
            "One or more images could not be inspected safely. Retry or remove those images before confirming the lots.",
          data: {
            unreadableFileIds: inspectionErrors.map(({ fileId }) => fileId),
            inspectionErrors,
          },
        });
      }
      if (confirm && warnings.length) {
        return res.status(400).json({
          code: "INVALID_SMART_UPLOAD_GROUPING",
          message: warnings[0],
          data: { groups, dividerFileIds, warnings },
        });
      }

      const nextGrouping = {
        ...(session.smartGrouping || {}),
        status: confirm ? "confirmed" : "review_ready",
        progressPercent: 100,
        revision: currentRevision + 1,
        algorithmVersion: SMART_UPLOAD_ALGORITHM_VERSION,
        orderSource:
          orderSource ||
          (imageFiles.every((file) =>
            Number.isFinite(Number(file.captureOrder))
          )
            ? "capture"
            : "manifest"),
        orderReviewRequired,
        unresolvedDividerIds,
        dividerFileIds,
        groups,
        warnings,
        metrics: session.smartGrouping?.metrics || [],
        ...(confirm ? { confirmedAt: new Date() } : {}),
      } as any;
      const revisionFilter =
        currentRevision === 0
          ? {
              $or: [
                { "smartGrouping.revision": 0 },
                { "smartGrouping.revision": { $exists: false } },
                { "smartGrouping.revision": null },
              ],
            }
          : { "smartGrouping.revision": currentRevision };
      const updated = await ReportUploadSession.findOneAndUpdate(
        {
          _id: session._id,
          type,
          user: req.userId as any,
          smartUpload: true,
          status: { $nin: ["completed", "queued", "processed"] },
          cleanupStartedAt: { $exists: false },
          ...revisionFilter,
        },
        {
          $set: {
            smartGrouping: nextGrouping,
            ...(hasOrderedFileIds || hasAuthoritativeGroups
              ? { files: session.files }
              : {}),
          },
        },
        { new: true, runValidators: true }
      );
      if (!updated) {
        const latest = await findOwnedSmartSession(req, type);
        return res.status(409).json({
          code: "SMART_UPLOAD_GROUPING_STALE",
          message:
            "This Smart Upload was changed in another tab. Refresh the review before saving again.",
          data: {
            revision: Number(latest?.smartGrouping?.revision || 0),
          },
        });
      }
      try {
        await syncSmartUploadReportDraft(updated);
      } catch (error) {
        // The revisioned upload-session update above is the source of truth.
        // Draft projection is recoverable and must not make the client retry a
        // successful edit with a now-stale revision.
        console.error(
          "[SmartUpload] grouping draft projection sync failed; primary grouping remains committed",
          {
            sessionId: String(updated._id),
            revision: Number(updated.smartGrouping?.revision || 0),
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
      return res.status(200).json({ data: groupingPayload(updated) });
    } catch (error) {
      console.error("[SmartUpload] grouping update failed:", error);
      return res.status(500).json({
        message: "Unable to save divider changes.",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export function cancelSmartUploadSession(type: ReportUploadSessionType) {
  return async (req: AuthRequest, res: Response) => {
    try {
      const session = await findOwnedSmartSession(req, type);
      if (!session) return res.status(204).send();
      if (["completed", "queued", "processed"].includes(session.status)) {
        return res.status(409).json({
          message: "The report has already been created and cannot be cancelled here.",
        });
      }
      if (session.cleanupStartedAt) {
        return res.status(409).json({
          code: "SMART_UPLOAD_SESSION_CLEANUP_STARTED",
          message:
            "This expired Smart Upload is already being cleaned up.",
        });
      }
      const cleanupStartedAt = new Date();
      const claimed = await ReportUploadSession.findOneAndUpdate(
        {
          _id: session._id,
          type,
          user: req.userId as any,
          smartUpload: true,
          status: { $in: ["created", "uploading", "failed"] },
          cleanupStartedAt: { $exists: false },
          updatedAt: (session as any).updatedAt,
        },
        {
          $set: { cleanupStartedAt },
          $unset: { activeContractClaim: 1 },
        },
        { new: true }
      );
      if (!claimed) {
        const latest = await findOwnedSmartSession(req, type);
        if (!latest) return res.status(204).send();
        return res.status(409).json({
          code: "SMART_UPLOAD_SESSION_LOCKED",
          message:
            "This Smart Upload changed or started creating its report and can no longer be cancelled.",
        });
      }
      const storageTarget = resolvePersistedR2StorageTarget(claimed);
      const bucketName = storageTarget.bucketName;
      let failedObjects = 0;
      if (storageTarget.generation === "current") {
        await mapWithConcurrency(
          claimed.files,
          getPositiveIntEnv("SMART_UPLOAD_DELETE_CONCURRENCY", 8),
          async (file) => {
            try {
              await deleteFromR2Strict(bucketName, file.key);
            } catch (error) {
              failedObjects += 1;
              console.warn("[SmartUpload] cancelled object cleanup failed", {
                sessionId: String(claimed._id),
                key: file.key,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        );
      }
      if (failedObjects === 0) {
        await ReportUploadSession.deleteOne({
          _id: claimed._id,
          cleanupStartedAt,
        });
      } else {
        await ReportUploadSession.updateOne(
          { _id: claimed._id, cleanupStartedAt },
          {
            $set: {
              lastError: `Smart Upload cancellation could not remove ${failedObjects} object(s). Cleanup will retry automatically.`,
            },
          }
        );
      }
      void deleteReportDraftForSubmission(
        claimed.user,
        claimed.type,
        claimed.clientSubmissionId
      ).catch((error) => {
        console.error("[SmartUpload] cancelled draft cleanup failed", {
          sessionId: String(claimed._id),
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return res.status(204).send();
    } catch (error) {
      console.error("[SmartUpload] cancellation failed:", error);
      return res.status(500).json({
        message: "Unable to cancel this Smart Upload session.",
      });
    }
  };
}
