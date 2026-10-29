/**
 * Maintains the durable association between an Auctioneer work item and its generated
 * report. Conditional updates prevent relinking after a competing submission wins, and
 * report deletion/unlink paths restore only states that are safe to claim again.
 */
import { Types } from "mongoose";
import { resolveScheduleAMapping } from "./auctioneerScheduleAMapping.js";
import {
  SCHEDULE_A_ITEM_REQUIRED_CODE,
  SCHEDULE_A_ITEM_REQUIRED_MESSAGE,
  SCHEDULE_A_PARENT_LOT_FIELD,
  inheritScheduleAItemLinks,
  lotsMissingScheduleAItem,
  requiresScheduleAItem,
  scheduleAChoiceParentLotIds,
  scheduleAParentLotId,
} from "./auctioneerScheduleAItemLink.js";
import {
  PROPOSAL_ITEM_INVALID_CODE,
  PROPOSAL_ITEM_INVALID_MESSAGE,
  isProposalListWorkItem,
  proposalItemSourceKey,
  proposalLineIdFromSourceKey,
  proposalLotLineIds,
} from "./auctioneerProposalList.js";
import AuctioneerWorkItem, {
  type AuctioneerReportType,
  type IAuctioneerWorkItem,
} from "../models/auctioneerWorkItem.model.js";

export class AuctioneerReportContextError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "AuctioneerReportContextError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function asObjectId(value: unknown): Types.ObjectId | null {
  const text = String(value || "").trim();
  return Types.ObjectId.isValid(text) ? new Types.ObjectId(text) : null;
}

function plainId(value: unknown): string {
  if (value && typeof value === "object" && "_id" in (value as any)) {
    return String((value as any)._id);
  }
  return String(value || "");
}

function canonicalizeAuctioneerLots(
  details: Record<string, any>,
  item: IAuctioneerWorkItem
) {
  const submittedLots = Array.isArray(details.mixed_lots)
    ? details.mixed_lots
    : [];
  const sourceLots = Array.isArray(item.snapshot?.lots)
    ? item.snapshot.lots
    : [];

  if (item.kind === "scheduleA") {
    let mappings: ReturnType<typeof resolveScheduleAMapping>;
    try {
      mappings = resolveScheduleAMapping(sourceLots, submittedLots.map((lot: any) => ({ key: lot?.source_key, parentKey: lot?.source_parent_key })));
    } catch {
      throw new AuctioneerReportContextError(
        "The Schedule A lot mapping does not match the claimed Auctioneer contract.",
        409,
        "AUCTIONEER_SCHEDULE_A_MAPPING_MISMATCH"
      );
    }
    details.mixed_lots = submittedLots.map(
      (submitted: Record<string, any>, index: number) => {
        const { source, key, parentKey } = mappings[index];
        const submittedKey = String(submitted?.source_key || "").trim();
        const submittedLotId = String(submitted?.source_lot_id || "").trim();
        const submittedSubmissionId = String(
          submitted?.source_submission_id || ""
        ).trim();
        if (
          (submittedKey && submittedKey !== key) ||
          (submittedLotId &&
            submittedLotId !== String(source.lotId || "")) ||
          (submittedSubmissionId &&
            submittedSubmissionId !== String(source.submissionId || ""))
        ) {
          throw new AuctioneerReportContextError(
            "The Schedule A lot mapping was changed. Reload the claimed contract and try again.",
            409,
            "AUCTIONEER_SCHEDULE_A_MAPPING_MISMATCH"
          );
        }
        // A Schedule A work item links its splits through source_parent_key;
        // the unknown-work link field means nothing here and is dropped.
        const { [SCHEDULE_A_PARENT_LOT_FIELD]: _scheduleAParentLotId, ...lineLot } = submitted || {};
        return {
          ...lineLot,
          mode: "single_lot",
          source_key: key,
          source_parent_key: parentKey || undefined,
          ...(source.lotId ? { source_lot_id: source.lotId } : {}),
          ...(source.submissionId
            ? { source_submission_id: source.submissionId }
            : {}),
        };
      }
    );
    return;
  }

  if (!submittedLots.length) {
    throw new AuctioneerReportContextError(
      "At least one Unknown Lot is required.",
      400,
      "AUCTIONEER_UNKNOWN_LOT_REQUIRED"
    );
  }
  if (isProposalListWorkItem(item)) {
    canonicalizeProposalListLots(details, item, submittedLots);
    return;
  }
  /*
     Owner 2026-10-28: on a contract with a Schedule A, every lot of this
     lines-free work item must name the Schedule A item it belongs to, and only
     an item the work item offers counts (ticked "Several lots", with an
     Auctioneer lot to create under). Without one the submission is refused
     before any photo is processed. Anywhere else the link is not accepted, so
     it can never be forged onto a plain Unknown Lot.
  */
  const linkRequired = requiresScheduleAItem(item);
  const allowedParents = scheduleAChoiceParentLotIds(item);
  details.mixed_lots = submittedLots.map(
    (submitted: Record<string, any>, index: number) => {
      const source = index === 0 ? sourceLots[0] : undefined;
      const {
        source_key: _sourceKey,
        source_parent_key: _sourceParentKey,
        source_lot_id: _sourceLotId,
        source_submission_id: _sourceSubmissionId,
        [SCHEDULE_A_PARENT_LOT_FIELD]: _scheduleAParentLotId,
        ...editableLot
      } = submitted || {};
      const scheduleAParent = linkRequired ? scheduleAParentLotId(submitted) : "";
      if (linkRequired && !allowedParents.has(scheduleAParent)) {
        throw new AuctioneerReportContextError(
          SCHEDULE_A_ITEM_REQUIRED_MESSAGE,
          409,
          SCHEDULE_A_ITEM_REQUIRED_CODE
        );
      }
      return {
        ...editableLot,
        source_key:
          source?.sourceKey || `${String(item._id)}:unknown:${index + 1}`,
        ...(source?.lotId ? { source_lot_id: source.lotId } : {}),
        ...(source?.submissionId
          ? { source_submission_id: source.submissionId }
          : {}),
        ...(scheduleAParent ? { [SCHEDULE_A_PARENT_LOT_FIELD]: scheduleAParent } : {}),
      };
    }
  );
}

/*
   A Proposal worked from its list (owner 2026-10-28). A lot that names one of
   the user's listed items keeps that item's source key and is one lot — a
   listed item comes back as exactly one item, so its photos are never split
   into several lots that would all claim it. Every other lot is an item that
   was not on the list and gets an ordinary local key. A listed key that is
   not this user's, or that two lots share, is refused before any photo is
   processed rather than sent as an extra the appraiser did not intend.
*/
function canonicalizeProposalListLots(
  details: Record<string, any>,
  item: IAuctioneerWorkItem,
  submittedLots: Record<string, any>[]
) {
  const listed = new Set(
    (item.proposalList?.items || []).map((entry) => proposalItemSourceKey(entry.lineId))
  );
  const used = new Set<string>();
  details.mixed_lots = submittedLots.map((submitted, index) => {
    const {
      source_key: submittedKey,
      source_parent_key: _sourceParentKey,
      source_lot_id: _sourceLotId,
      source_submission_id: _sourceSubmissionId,
      [SCHEDULE_A_PARENT_LOT_FIELD]: _scheduleAParentLotId,
      ...editableLot
    } = submitted || {};
    const key = typeof submittedKey === "string" ? submittedKey.trim() : "";
    if (proposalLineIdFromSourceKey(key)) {
      if (!listed.has(key) || used.has(key)) {
        throw new AuctioneerReportContextError(
          PROPOSAL_ITEM_INVALID_MESSAGE,
          409,
          PROPOSAL_ITEM_INVALID_CODE
        );
      }
      used.add(key);
      return { ...editableLot, mode: "single_lot", source_key: key };
    }
    return { ...editableLot, source_key: `${String(item._id)}:unknown:${index + 1}` };
  });
}

/** The listed items a canonical submission captures (see canonicalizeProposalListLots). */
function submittedProposalLineIds(details: Record<string, any>): string[] {
  const lots = Array.isArray(details.mixed_lots) ? details.mixed_lots : [];
  return proposalLotLineIds(lots).filter(Boolean);
}

/**
 * Puts back Schedule A item links a client did not send with its preview data
 * (owner 2026-10-28). For the other paths that save client preview data —
 * submit/resubmit and an assigned approver's edits — which must never drop a
 * link but do not decide it: Send still refuses a lot without a valid one.
 */
export function restoreScheduleAItemLinks<T extends Record<string, any>>(
  previewData: T,
  previousPreviewData: unknown
): T {
  if (!previewData || !Array.isArray(previewData.lots)) return previewData;
  const previousLots = (previousPreviewData as any)?.lots;
  if (!Array.isArray(previousLots) || !previousLots.length) return previewData;
  return { ...previewData, lots: inheritScheduleAItemLinks(previewData.lots, previousLots) };
}

/**
 * Applies the Schedule A item rule to a preview edit of a report linked to an
 * Auctioneer work item (owner 2026-10-28): a lot may not be left, or added,
 * without a valid schedule_a_parent_lot_id while the work item still has to
 * be sent. Links the client did not send back are restored first (see
 * inheritScheduleAItemLinks), so an editor that does not know the field never
 * loses them. Returns the preview data to save; throws the same 409 as
 * report submission. A report with no work item costs no read; sent work and
 * work items that need no item are never refused.
 */
export async function applyPreviewScheduleAItemRule<T extends Record<string, any>>(input: {
  workItemId: unknown;
  previewData: T;
  previousPreviewData: unknown;
}): Promise<T> {
  const previewData = restoreScheduleAItemLinks(input.previewData, input.previousPreviewData);
  if (!Array.isArray(previewData?.lots)) return previewData;
  const workItemId = asObjectId(plainId(input.workItemId));
  if (!workItemId) return previewData;
  const item = await AuctioneerWorkItem.findById(workItemId)
    .select("kind contract.hasScheduleA scheduleAChoices proposalList status delivery.status")
    .lean();
  if (!item || !requiresScheduleAItem(item as any) ||
      item.status === "sent" || item.delivery?.status === "sent") {
    return previewData;
  }
  if (lotsMissingScheduleAItem(item as any, previewData.lots).length) {
    throw new AuctioneerReportContextError(
      SCHEDULE_A_ITEM_REQUIRED_MESSAGE,
      409,
      SCHEDULE_A_ITEM_REQUIRED_CODE
    );
  }
  return previewData;
}

export function applyCanonicalAuctioneerDetails(
  details: Record<string, any>,
  item: IAuctioneerWorkItem
) {
  const contract = item.contract;
  details.auctioneer_work_item_id = String(item._id);
  details.client_submission_id = item.clientSubmissionId;
  details.contract_no = contract.contractNo;
  // Imported location is an editable starting value. Contract number and event
  // date remain canonical, but a field worker may refine the actual sale/site
  // location before generating the report.
  details.location = details.location || contract.location || "";
  details.currency = details.currency || "CAD";

  if (item.selectedReportType === "asset") {
    details.client_name = details.client_name || contract.customerName || "";
    details.owner_name = details.owner_name || contract.customerName || "";
    details.prepared_for = details.prepared_for || contract.customerName || "";
    details.effective_date = contract.eventDate || details.effective_date;
    details.industry = details.industry || "";
  } else {
    details.sales_date =
      contract.eventDate || details.sales_date || new Date().toISOString();
  }
  canonicalizeAuctioneerLots(details, item);
  return details;
}

export async function resolveAuctioneerReportContext(input: {
  details: Record<string, any>;
  userId: unknown;
  reportType: AuctioneerReportType;
}): Promise<IAuctioneerWorkItem | null> {
  const requestedId = String(
    input.details?.auctioneer_work_item_id || ""
  ).trim();
  if (!requestedId) return null;

  const workItemId = asObjectId(requestedId);
  const userId = asObjectId(input.userId);
  if (!workItemId || !userId) {
    throw new AuctioneerReportContextError(
      "The Auctioneer work item is invalid.",
      400,
      "AUCTIONEER_WORK_ITEM_INVALID"
    );
  }

  const item = await AuctioneerWorkItem.findById(workItemId);
  if (!item) {
    throw new AuctioneerReportContextError(
      "The Auctioneer work item was not found.",
      404,
      "AUCTIONEER_WORK_ITEM_NOT_FOUND"
    );
  }
  if (plainId(item.claimedBy) !== String(userId)) {
    throw new AuctioneerReportContextError(
      "This Auctioneer contract is claimed by another user.",
      403,
      "AUCTIONEER_WORK_ITEM_NOT_OWNER"
    );
  }
  if (item.selectedReportType !== input.reportType) {
    throw new AuctioneerReportContextError(
      "The selected report type does not match this Auctioneer work item.",
      409,
      "AUCTIONEER_REPORT_TYPE_MISMATCH"
    );
  }
  if (item.status === "sent" || item.delivery.status === "sent") {
    throw new AuctioneerReportContextError(
      "This Auctioneer report was already sent and cannot create another report.",
      409,
      "AUCTIONEER_ALREADY_SENT"
    );
  }
  if (item.status === "abandoned") {
    throw new AuctioneerReportContextError(
      "This Auctioneer claim was released. Claim the contract again before creating a report.",
      409,
      "AUCTIONEER_CLAIM_RELEASED"
    );
  }

  applyCanonicalAuctioneerDetails(input.details, item);
  if (isProposalListWorkItem(item)) {
    /*
       Owner 2026-10-28: remember which listed items this submission captures,
       so a "Create Lot & Continue" successor does not offer them again while
       this report is on its way. Each submission of the work item replaces
       the record; a write that loses a race only affects what is offered.
    */
    const lineIds = submittedProposalLineIds(input.details);
    await AuctioneerWorkItem.updateOne(
      { _id: item._id, status: { $in: ["claimed", "report_created"] } },
      { $set: { proposalCapturedLineIds: lineIds } }
    );
  }
  return item;
}

export async function linkAuctioneerReport(input: {
  item: IAuctioneerWorkItem;
  userId: unknown;
  reportType: AuctioneerReportType;
  reportId: unknown;
}) {
  const workItemId = asObjectId(input.item._id);
  const userId = asObjectId(input.userId);
  const reportId = asObjectId(input.reportId);
  if (!workItemId || !userId || !reportId) {
    throw new AuctioneerReportContextError(
      "The Auctioneer report link is invalid.",
      400,
      "AUCTIONEER_REPORT_LINK_INVALID"
    );
  }
  const linkedReportModel =
    input.reportType === "asset" ? "AssetReport" : "LotListing";
  const updated = await AuctioneerWorkItem.findOneAndUpdate(
    {
      _id: workItemId,
      claimedBy: userId,
      selectedReportType: input.reportType,
      status: { $in: ["claimed", "report_created"] },
      $or: [
        { linkedReportId: { $exists: false } },
        { linkedReportId: null },
        { linkedReportId: reportId },
      ],
    },
    {
      $set: {
        linkedReportId: reportId,
        linkedReportModel,
        status: "report_created",
        "delivery.status": "not_ready",
      },
    },
    { returnDocument: "after" }
  );
  if (!updated) {
    throw new AuctioneerReportContextError(
      "This Auctioneer contract already has a different report.",
      409,
      "AUCTIONEER_REPORT_ALREADY_LINKED"
    );
  }
  return updated;
}

export function auctioneerContextErrorBody(error: unknown) {
  if (!(error instanceof AuctioneerReportContextError)) return null;
  return {
    statusCode: error.statusCode,
    body: { code: error.code, message: error.message },
  };
}
