/**
 * Projects persisted drafts and Smart Upload sessions into the client draft contract.
 * The compound user/type/client id makes synchronization idempotent, while session data
 * is resolved at read time so grouping progress is current without duplicating large
 * upload state into the draft document.
 */
import ReportDraft from "../models/reportDraft.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import {
  getR2PublicUrl,
  resolvePersistedR2StorageTarget,
} from "../utils/r2Storage/r2Upload.js";
import { resolveSmartUploadOrderReviewState } from "../utils/smartUploadReviewState.js";
import { normalizeReportContractKey } from "../utils/reportContractIdentity.js";
import { draftMediaClientValue, sortDraftMedia } from "./reportDraftMediaService.js";
import { smartUploadGroupingMethod } from "./lotNumberUploadGrouping.js";

export const normalizeDraftContract = normalizeReportContractKey;

export const normalizeDraftClientId = (value: unknown) =>
  String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "-")
    .slice(0, 160);

export const sessionTypeToDraftType = (type: unknown) =>
  ["lotListing", "lot-listing"].includes(String(type))
    ? "lotListing"
    : "asset";

export async function syncSmartUploadReportDraft(session: any) {
  if (!session?.smartUpload || !session?.user || !session?.clientSubmissionId) return null;
  const details = session.details || {};
  const type = sessionTypeToDraftType(session.type);
  const contractNo = String(details.contract_no || "").trim();
  return ReportDraft.findOneAndUpdate(
    {
      user: session.user,
      type,
      clientDraftId: normalizeDraftClientId(session.clientSubmissionId),
    },
    {
      $set: {
        storageMode: "smart_upload",
        smartUploadSession: session._id,
        contractNo,
        normalizedContractNo: normalizeDraftContract(contractNo),
        title: String(details.client_name || details.title || contractNo || "Smart Upload").trim(),
        formData: details,
        lots: session.smartGrouping?.groups || [],
        media: [],
      },
      $setOnInsert: { user: session.user, type, revision: 0 },
    },
    {
      upsert: true, new: true, setDefaultsOnInsert: true,
      // This is a recoverable projection of the authoritative upload session.
      // Bound database waits so a saved grouping cannot hold the HTTP response
      // until the browser/proxy times out. Callers retain the session on failure.
      maxTimeMS: 5_000,
      timeoutMS: 10_000,
    }
  );
}

export async function deleteReportDraftForSubmission(
  userId: unknown,
  type: unknown,
  clientSubmissionId: unknown,
  options?: { notUpdatedAfter: Date },
) {
  const clientDraftId = normalizeDraftClientId(clientSubmissionId);
  if (!clientDraftId) return;
  const draft = await ReportDraft.findOneAndDelete({
    user: userId as any,
    type: sessionTypeToDraftType(type),
    clientDraftId,
    promotedAt: null,
    promotionToken: null,
    // Acceptance cleanup is delayed/best-effort. A later save under the same
    // identity is new user work, including changes that leave photos unchanged.
    // Apply the cutoff atomically so cleanup cannot race that newer save.
    ...(options ? { updatedAt: { $lt: options.notUpdatedAfter } } : {}),
  });
  if (!draft) return;

  // A processed draft uses a hidden report document. Once the real submission
  // succeeds, remove that private derivative so it cannot become stale or be
  // counted as a second report.
  await Promise.all([
    AssetReport.deleteMany({
      user: userId as any,
      source_draft_id: draft._id,
      is_draft_preview: true,
    } as any),
    LotListing.deleteMany({
      user: userId as any,
      source_draft_id: draft._id,
      is_draft_preview: true,
    } as any),
  ]);
}

export async function toReportDraftClient(draft: any) {
  const raw = typeof draft?.toObject === "function" ? draft.toObject() : draft;
  if (!raw) return raw;
  const result: Record<string, any> = { ...raw, id: String(raw._id) };
  // Promotion claims are an internal lease/CAS mechanism. In particular,
  // stale claims can be listed for recovery, but their bearer-like token and
  // timing metadata must never be exposed to the browser.
  delete result.promotionToken;
  delete result.promotionClaimedAt;
  delete result.mediaRevision;
  delete result.contentHash;
  result.media = sortDraftMedia((raw.media || []).map(draftMediaClientValue)).map(
    (item: any) => ({
      ...item,
      contentPath: `/report-drafts/${String(raw._id)}/media/${encodeURIComponent(
        String(item.clientFileId)
      )}/content`,
    })
  );
  if (raw.storageMode !== "smart_upload" || !raw.smartUploadSession) return result;

  const draftOwnerId =
    raw.user && typeof raw.user === "object" ? raw.user._id : raw.user;
  const session = await ReportUploadSession.findOne({
    _id: raw.smartUploadSession,
    user: draftOwnerId,
    smartUpload: true,
  }).lean();
  if (!session) {
    result.smartUploadSummary = {
      groupingStatus: "failed",
      progressPercent: 0,
      orderReviewRequired: false,
      unresolvedDividerIds: [],
      groups: [],
      warnings: ["The Smart Upload session is no longer available."],
    };
    return result;
  }
  const storageTarget = resolvePersistedR2StorageTarget(session);

  const filesById = new Map(
    (session.files || []).map((file: any) => [String(file.fileId), file])
  );
  const groups = (session.smartGrouping?.groups || []).map((group: any) => ({
    ...group,
    files: (group.fileIds || [])
      .map((fileId: unknown) => filesById.get(String(fileId)))
      .filter(Boolean)
      .map((file: any) => ({
        fileId: String(file.fileId),
        name: String(file.originalname || "image"),
        mimeType: String(file.mimetype || "image/jpeg"),
        size: Number(file.verifiedSize || file.size || 0),
        url: getR2PublicUrl(String(file.key), storageTarget),
        originalOrder: Number(file.originalOrder || 0),
      })),
  }));
  const orderReviewState = resolveSmartUploadOrderReviewState({
    orderReviewRequired: session.smartGrouping?.orderReviewRequired,
    unresolvedDividerIds: session.smartGrouping?.unresolvedDividerIds,
    dividerFileIds: session.smartGrouping?.dividerFileIds || [],
    detailsOrderAmbiguous:
      session.details?.smart_upload_order_ambiguous,
  });
  result.formData = session.details || raw.formData || {};
  result.lots = groups;
  result.smartUploadSummary = {
    sessionId: String(session._id),
    groupingMethod: smartUploadGroupingMethod(session),
    groupingStatus: session.smartGrouping?.status || "uploading",
    progressPercent: Number(session.smartGrouping?.progressPercent || 0),
    revision: Number(session.smartGrouping?.revision || 0),
    orderSource: session.smartGrouping?.orderSource,
    orderReviewRequired: orderReviewState.orderReviewRequired,
    unresolvedDividerIds: orderReviewState.unresolvedDividerIds,
    unresolvedLotNumberFileIds: session.smartGrouping?.unresolvedLotNumberFileIds || [],
    groups,
    dividerFileIds: session.smartGrouping?.dividerFileIds || [],
    warnings: session.smartGrouping?.warnings || [],
    error: session.smartGrouping?.error,
    expectedFileCount: Number(session.expectedFileCount || 0),
    confirmedFileCount: (session.files || []).filter((file: any) => file.uploadedAt).length,
  };
  return result;
}
