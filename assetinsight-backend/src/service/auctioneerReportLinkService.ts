/**
 * Maintains the durable association between an Auctioneer work item and its generated
 * report. Conditional updates prevent relinking after a competing submission wins, and
 * report deletion/unlink paths restore only states that are safe to claim again.
 */
import { Types } from "mongoose";
import { resolveScheduleAMapping } from "./auctioneerScheduleAMapping.js";
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
        return {
          ...submitted,
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
  details.mixed_lots = submittedLots.map(
    (submitted: Record<string, any>, index: number) => {
      const source = index === 0 ? sourceLots[0] : undefined;
      const {
        source_key: _sourceKey,
        source_parent_key: _sourceParentKey,
        source_lot_id: _sourceLotId,
        source_submission_id: _sourceSubmissionId,
        ...editableLot
      } = submitted || {};
      return {
        ...editableLot,
        source_key:
          source?.sourceKey || `${String(item._id)}:unknown:${index + 1}`,
        ...(source?.lotId ? { source_lot_id: source.lotId } : {}),
        ...(source?.submissionId
          ? { source_submission_id: source.submissionId }
          : {}),
      };
    }
  );
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
