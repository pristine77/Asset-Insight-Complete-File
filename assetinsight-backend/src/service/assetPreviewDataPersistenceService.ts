import AssetReport from "../models/asset.model.js";
import { preserveAssetProposalValuationPreviewState } from "../utils/assetProposalValuationPreviewState.js";
import { mergeAssetAdminScheduleSheetAfterPreviewEdit } from "./assetAdminScheduleSheetService.js";
import { proposalValuationWritableRevisionCondition } from "./proposalValuationArtifactPublicationService.js";
import { broadcastProposalValuationRevision } from "./proposalValuationRealtimeService.js";
import { normalizeAssetPreviewCoverImages } from "../utils/assetCoverImages.js";

const SERVER_OWNED_PREVIEW_FIELDS = new Set(["admin_schedule_sheet"]);

function safePreviewKey(key: string): boolean {
  return Boolean(key) && !key.includes(".") && !key.startsWith("$");
}

/**
 * Persist generic preview_data fields with dotted writes while never replacing
 * PV-owned siblings. `previousPreviewData` limits unsets to fields this caller
 * actually observed, preserving unrelated concurrent additions as well.
 */
export async function persistAssetPreviewDataPreservingProposalValuation(input: {
  reportId: string;
  previewData: Record<string, any>;
  previousPreviewData?: Record<string, any>;
  proposalValuationRevision?: number;
}) {
  const next = input.previewData || {};
  const previous = input.previousPreviewData || {};
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};

  for (const [key, value] of Object.entries(next)) {
    if (SERVER_OWNED_PREVIEW_FIELDS.has(key) || !safePreviewKey(key)) continue;
    if (value === undefined) unset[`preview_data.${key}`] = 1;
    else set[`preview_data.${key}`] = value;
  }
  for (const key of Object.keys(previous)) {
    if (
      SERVER_OWNED_PREVIEW_FIELDS.has(key) ||
      !safePreviewKey(key) ||
      Object.prototype.hasOwnProperty.call(next, key)
    ) {
      continue;
    }
    unset[`preview_data.${key}`] = 1;
  }

  const update: Record<string, unknown> = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (!Object.keys(update).length) return;
  const persisted = await AssetReport.updateOne(
    {
      _id: input.reportId,
      ...(Number.isInteger(input.proposalValuationRevision)
        ? proposalValuationWritableRevisionCondition(
            Number(input.proposalValuationRevision)
          )
        : {}),
    },
    update
  );
  if (persisted.matchedCount !== 1) {
    throw Object.assign(
      new Error("Proposal Valuation changed while preview data was being saved"),
      { code: "PV_PREVIEW_WRITE_CONFLICT", statusCode: 409 }
    );
  }
}

/**
 * Save a generic preview mutation and its workflow/root fields in one guarded
 * Mongo update. The previous implementation split these into two writes, which
 * could commit workflow flags before a concurrent PV revision rejected the
 * preview write.
 */
export async function saveAssetReportWithProtectedPreviewData(input: {
  report: any;
  previousPreviewData?: Record<string, any>;
}) {
  const submittedPreviewData =
    input.report?.preview_data && typeof input.report.preview_data === "object"
      ? JSON.parse(JSON.stringify(input.report.preview_data))
      : {};
  const previousPreviewData = input.previousPreviewData || {};
  const previewDataWithCoverSelection =
    !Object.prototype.hasOwnProperty.call(
      submittedPreviewData,
      "cover_image_urls"
    ) &&
    Object.prototype.hasOwnProperty.call(
      previousPreviewData,
      "cover_image_urls"
    )
      ? {
          ...submittedPreviewData,
          cover_image_urls: previousPreviewData.cover_image_urls,
        }
      : submittedPreviewData;
  const previewData = preserveAssetProposalValuationPreviewState(
    normalizeAssetPreviewCoverImages(
      previewDataWithCoverSelection,
      input.report?.imageUrls
    ),
    previousPreviewData
  );
  const proposalValuationRevision = Number(
    input.report?.proposal_valuation_revision || 0
  );
  const scheduleMerge = mergeAssetAdminScheduleSheetAfterPreviewEdit({
    previousPreviewData,
    nextPreviewData: previewData,
  });
  const proposalValuationChanged = Boolean(
    scheduleMerge &&
      JSON.stringify(scheduleMerge.previousSheet) !==
        JSON.stringify(scheduleMerge.nextSheet)
  );
  const nextProposalValuationRevision = proposalValuationChanged
    ? proposalValuationRevision + 1
    : proposalValuationRevision;
  const proposalValuationUpdatedAt = proposalValuationChanged
    ? new Date()
    : undefined;
  if (
    proposalValuationChanged &&
    scheduleMerge &&
    scheduleMerge.hadStoredSheet
  ) {
    previewData.admin_schedule_sheet = scheduleMerge.nextSheet;
  }
  if (proposalValuationChanged) {
    input.report.proposal_valuation_revision = nextProposalValuationRevision;
    input.report.proposal_valuation_updated_at = proposalValuationUpdatedAt;
  }
  const expectedUpdatedAt = input.report?.updatedAt;
  input.report.preview_data = previewData;
  input.report.markModified?.("preview_data");
  input.report.$where = {
    $and: [
      proposalValuationWritableRevisionCondition(proposalValuationRevision),
      ...(expectedUpdatedAt ? [{ updatedAt: expectedUpdatedAt }] : []),
    ],
  };
  try {
    await input.report.save();
  } catch (error: any) {
    if (
      error?.name === "DocumentNotFoundError" ||
      error?.name === "VersionError"
    ) {
      throw Object.assign(
        new Error(
          "The report changed while preview data was being saved. Refresh and retry."
        ),
        { code: "PV_PREVIEW_WRITE_CONFLICT", statusCode: 409 }
      );
    }
    throw error;
  }

  if (proposalValuationChanged) {
    broadcastProposalValuationRevision({
      reportId: String(input.report._id),
      revision: nextProposalValuationRevision,
      updatedAt: proposalValuationUpdatedAt as Date,
    });
  }

  return {
    proposalValuationChanged,
    proposalValuationRevision: nextProposalValuationRevision,
  };
}
