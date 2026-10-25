import { Types } from "mongoose";
import WorkItem from "../models/auctioneerWorkItem.model.js";
import Asset from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import { getContractLots, listIncomingContracts, type Auctioneer2Record } from "./auctioneer2Client.js";
import { AuctioneerEventIdentityError, normalizeAuctioneerEventId, readAuctioneerContractIdentityCandidates, readAuctioneerEventIdentity, resolveAuctioneerEventIdentity } from "../utils/auctioneerEventIdentity.js";

export const AUCTIONEER_EVENT_REQUIRED_MESSAGE = "The imported contract needs an auction event before automatic lot numbers can be assigned. Ask the auction team to check its event.";
export class AuctioneerEventResolutionError extends Error {
  readonly statusCode = 409;
  constructor(message: string, readonly code: string) { super(message); this.name = "AuctioneerEventResolutionError"; }
}
const changed = () => new AuctioneerEventResolutionError("The imported report changed while checking its auction event. Refresh the saved report before retrying.", "auctioneer_event_context_changed");
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const at = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((source, key) => record(source) ? source[key] : undefined, value);
const idsAt = (value: unknown, paths: string[]): string[] => paths.map(path => normalizeAuctioneerEventId(at(value, path))).filter((id): id is string => id !== undefined);
const CONTEXT_KEYS = ["lot", "asset", "item", "contract"];
const ASSIGNEE_IDS = ["assignedTo.id", "assignedTo._id", "assigned_to.id", "assigned_to._id", "assignedTo", "assigned_to", "assignedUserId", "assigned_user_id", "assetInsightUserId", "asset_insight_user_id", "assignedUser.id", "assignedUser._id", "assignee.id", "assignee._id"];
function assertContractContext(value: unknown, contractId: string, standaloneContract = false) {
  if (readAuctioneerContractIdentityCandidates(value, { standaloneContract }).some(id => id !== contractId)) throw changed();
}

// Project identifiers only, including bounded supported nested contexts. Photos,
// notes and queued payloads must not be loaded just to recover missing metadata.
function eventProjection(prefix: string): Record<string, 1> {
  const projection: Record<string, 1> = {};
  const contexts = [{ prefix, depth: 0 }];
  for (const context of contexts) {
    for (const key of ["eventId", "event_id", "auctionEventId", "event.id", "contractId", "contract_id", "contractGuid", "contract_guid", "contract.id", "contract._id", "contract.uuid"]) projection[`${context.prefix}.${key}`] = 1;
    if (context.depth < 2) for (const key of CONTEXT_KEYS) contexts.push({ prefix: `${context.prefix}.${key}`, depth: context.depth + 1 });
  }
  return projection;
}

type RecoveryInput = { reportId: unknown; reportType: "asset" | "lotListing"; assertOwned?: () => Promise<void> };

/**
 * Only initial, unreviewed work may fill an absent canonical event identity.
 * Preserve the immutable source snapshot and record exactly where the correction
 * came from. A known event, reviewed preview or frozen delivery is never moved.
 * This reads provider metadata only; it does not submit lots or generate reports.
 */
export async function recoverInitialAuctioneerEventIdentity(input: RecoveryInput): Promise<{ eventId: string; contractId: string }> {
  const id = String(input.reportId ?? "");
  if (!Types.ObjectId.isValid(id)) throw changed();
  const reportId = new Types.ObjectId(id);
  const linkedReportModel = input.reportType === "asset" ? "AssetReport" : "LotListing";
  const reportProjection = "user auctioneerWorkItem status updatedAt adminArchivedAt is_draft_preview preview_submitted_at approval_requested_at approval_processed_at released_at preview_data.lots.lot_number preview_data.lots.lot_id";
  const [work, report] = await Promise.all([
    WorkItem.findOne({ linkedReportId: reportId, linkedReportModel, "delivery.manifest": null }).select({
      _id: 1, source: 1, contract: 1, claimedBy: 1, assignmentUserId: 1, status: 1, updatedAt: 1,
      linkedReportId: 1, linkedReportModel: 1, "delivery.status": 1, "delivery.manifest.reportId": 1,
      eventIdentityRecovery: 1, ...eventProjection("snapshot.contract"), "snapshot.contract.id": 1,
      "snapshot.contract._id": 1, "snapshot.contract.uuid": 1, "snapshot.event.id": 1, ...eventProjection("snapshot.event"),
      ...eventProjection("snapshot.tasks"), ...eventProjection("snapshot.lots.raw"),
    }).lean(),
    input.reportType === "asset" ? Asset.findById(reportId).select(reportProjection).lean() : LotListing.findById(reportId).select(reportProjection).lean(),
  ]);
  if (!work || !report || work.source !== "auctioneer2" || report.adminArchivedAt
    || String(report.auctioneerWorkItem || "") !== String(work._id)
    || String(report.user) !== String(work.claimedBy)
    || (work.assignmentUserId && String(work.assignmentUserId) !== String(report.user))
    || !["processing", "error"].includes(String(report.status))
    || report.is_draft_preview || report.preview_submitted_at || report.approval_requested_at || report.approval_processed_at || report.released_at
    || (Array.isArray((report.preview_data as any)?.lots) && (report.preview_data as any).lots.length)
    || ["abandoned", "sent"].includes(work.status)
    || work.delivery?.manifest || ["ready", "queued", "sending", "sent", "needs_reconciliation"].includes(work.delivery?.status)) throw changed();
  const contractId = normalizeAuctioneerEventId(work.contract?.id);
  if (!contractId) throw new AuctioneerEventResolutionError("The imported report is missing its contract ID. Ask support to check the saved import before retrying.", "auctioneer_lot_contract_required");
  // The worker lease callback alone is not a report revision fence. Recheck the
  // initial parent around network reads and the metadata CAS, including callers
  // without a lease callback. An edit, reassignment or submission stops recovery.
  const reportGuard = {
    _id: reportId, user: report.user, auctioneerWorkItem: report.auctioneerWorkItem,
    status: report.status,
    updatedAt: (report as any).updatedAt ? { $eq: (report as any).updatedAt } : { $exists: false },
    adminArchivedAt: null, is_draft_preview: { $ne: true },
    preview_submitted_at: null, approval_requested_at: null, approval_processed_at: null, released_at: null,
    "preview_data.lots.0": { $exists: false },
  };
  const assertCurrent = async () => {
    await input.assertOwned?.();
    const exists = input.reportType === "asset" ? await Asset.exists(reportGuard) : await LotListing.exists(reportGuard);
    if (!exists) throw changed();
  };
  await assertCurrent();
  const existing = normalizeAuctioneerEventId(work.contract?.eventId);
  if (existing) return { eventId: existing, contractId };

  try {
    assertContractContext(work.snapshot?.contract, contractId, true);
    assertContractContext(work.snapshot?.event, contractId);
    const tasks = work.snapshot?.tasks || [];
    const lots = work.snapshot?.lots || [];
    for (const value of [...tasks, ...lots.map(lot => lot.raw)]) assertContractContext(value, contractId);
    let eventId = resolveAuctioneerEventIdentity([
      readAuctioneerEventIdentity(work.snapshot?.contract),
      readAuctioneerEventIdentity(work.snapshot?.event, { standaloneEvent: true }),
      ...tasks.map(value => readAuctioneerEventIdentity(value)),
      ...lots.map(value => readAuctioneerEventIdentity(value.raw)),
    ]);
    let source: "saved_snapshot" | "assigned_contract" | "contract_lots" = "saved_snapshot";
    if (!eventId) {
      // No cached Incoming read: a correction made upstream must be visible on Retry.
      const contracts = await listIncomingContracts(String(report.user));
      await assertCurrent();
      const matching = contracts.filter(value => readAuctioneerContractIdentityCandidates(value, { standaloneContract: true }).includes(contractId));
      for (const value of matching) {
        assertContractContext(value, contractId, true);
        const assignments = idsAt(value, ASSIGNEE_IDS);
        const statuses = idsAt(value, ["status", "contractStatus", "contract_status"]);
        if (!assignments.length || assignments.some(owner => owner.toLowerCase() !== String(report.user).toLowerCase())
          || !statuses.length || statuses.some(status => status !== "ProposalInAssetInsight")) {
          throw new AuctioneerEventResolutionError("The auction contract is no longer assigned to this user for Asset Insight work. Ask the auction team to check its assignment before retrying.", "auctioneer_event_assignment_unavailable");
        }
      }
      eventId = resolveAuctioneerEventIdentity(matching.map(value => readAuctioneerEventIdentity(value)));
      source = "assigned_contract";
      // Existing legacy task-only claims may not appear in the Proposal feed.
      // A contract-scoped lot is evidence only when it also identifies the exact
      // contract; a bare event ID on an unrelated/malformed row is not sufficient.
      if (!eventId) {
        const currentLots: Auctioneer2Record[] = await getContractLots(contractId);
        await assertCurrent();
        for (const value of currentLots) assertContractContext(value, contractId);
        eventId = resolveAuctioneerEventIdentity(currentLots
          .filter(value => readAuctioneerContractIdentityCandidates(value).includes(contractId))
          .map(value => readAuctioneerEventIdentity(value)));
        source = "contract_lots";
      }
    }
    if (!eventId) throw new AuctioneerEventResolutionError(AUCTIONEER_EVENT_REQUIRED_MESSAGE, "auctioneer_lot_event_required");
    await assertCurrent();
    const guard = {
      _id: work._id, source: "auctioneer2", linkedReportId: reportId, linkedReportModel, claimedBy: work.claimedBy,
      assignmentUserId: work.assignmentUserId ?? null,
      "contract.id": contractId, "contract.eventId": { $eq: work.contract.eventId ?? null },
      updatedAt: work.updatedAt ? { $eq: work.updatedAt } : { $exists: false },
      status: { $nin: ["abandoned", "sent"] },
      "delivery.status": { $nin: ["ready", "queued", "sending", "sent", "needs_reconciliation"] },
      "delivery.manifest": null,
    };
    // This is the sole narrow exception to immutable contract metadata: fill
    // the exact missing field with verified evidence, retaining an audit receipt.
    // Mongoose middleware still captures any associated activity outbox intent.
    const result = await WorkItem.updateOne(guard, { $set: {
      "contract.eventId": eventId,
      eventIdentityRecovery: { eventId, source, resolvedAt: new Date() },
    } }, { overwriteImmutable: true });
    await assertCurrent();
    if (result.modifiedCount !== 1) {
      const winner = await WorkItem.findOne({ ...guard, "contract.eventId": eventId, updatedAt: { $exists: true } })
        .select("eventIdentityRecovery.eventId").lean();
      if (winner?.eventIdentityRecovery?.eventId !== eventId) throw changed();
    }
    return { eventId, contractId };
  } catch (error) {
    if (error instanceof AuctioneerEventIdentityError) throw new AuctioneerEventResolutionError(error.message, error.code);
    throw error;
  }
}
