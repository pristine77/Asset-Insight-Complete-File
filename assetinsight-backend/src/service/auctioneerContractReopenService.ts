import { createHash, randomUUID } from "node:crypto";
import { Types } from "mongoose";
import User from "../models/user.model.js";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import AuctioneerContractClose from "../models/auctioneerContractClose.model.js";
import { Auctioneer2ClientError, getContractCapturePermission, listIncomingContracts, reopenContractForUser } from "./auctioneer2Client.js";
import { assertNoQueuedContinuationUpload, auctioneerContractStateId, getAuctioneerContractCaptureState, withAuctioneerContractOperation } from "./auctioneerContractCloseService.js";

function identity(contractId: unknown, userId: string): string {
  if (!Types.ObjectId.isValid(userId)) throw new Auctioneer2ClientError("Sign in again to view your assigned contracts.", { statusCode: 401, code: "invalid_user" });
  if (typeof contractId !== "string" || !contractId.trim() || contractId.trim().length > 200) throw new Auctioneer2ClientError(
    "Refresh Incoming to select a valid contract.", { statusCode: 400, code: "invalid_contract" });
  return contractId.trim();
}

async function requireAssignment(contractId: string, userId: string) {
  const user = await User.findOne({ _id: userId, role: "user", isVerified: true, isBlocked: { $ne: true } }).select("username email").lean();
  if (!user) throw new Auctioneer2ClientError("This account cannot reopen assigned contracts.", { statusCode: 403, code: "auctioneer_assignee_unavailable" });
  const own = await AuctioneerWorkItem.exists({ "contract.id": contractId, claimedBy: userId, assignmentUserId: userId });
  if (!own) {
    // This also supports a completed contract whose local report was never made.
    // A display name, contract number or another user's work is never authority.
    const contracts = await listIncomingContracts(userId, true);
    const assigned = contracts.some(raw => {
      const id = raw.id ?? raw._id ?? raw.contractId ?? raw.contractGuid;
      const assignedId = raw.assignedUserId ?? raw.assetInsightUserId;
      return id === contractId && typeof assignedId === "string" && assignedId.toLowerCase() === userId.toLowerCase();
    });
    if (!assigned) throw new Auctioneer2ClientError("This contract is not assigned to you. Refresh Incoming or contact the auction team.",
      { statusCode: 404, code: "auctioneer_contract_assignment_not_found" });
  }
  return user;
}

export async function getAuctioneerCapturePermission(contractId: unknown, userId: string) {
  const id = identity(contractId, userId);
  await requireAssignment(id, userId);
  const state = await getAuctioneerContractCaptureState(id, userId);
  try {
    const permission = await getContractCapturePermission(id, userId);
    return { ...permission, ...(state?.status === "reopen_pending" ? { confirmationPending: true } : {}) };
  } catch (error) {
    if (error instanceof Auctioneer2ClientError && [404, 405, 501].includes(error.upstreamStatus || 0)) return {
      reopen: { allowed: false, reason: null, reopenUntil: null }, ...(state?.status === "reopen_pending" ? { confirmationPending: true } : {}) };
    throw error;
  }
}

export async function reopenAuctioneerContractPart(contractId: unknown, userId: string) {
  const id = identity(contractId, userId);
  return withAuctioneerContractOperation(id, userId, async lease => {
    const user = await requireAssignment(id, userId);
    const previous = await getAuctioneerContractCaptureState(id, userId);
    if (previous?.status === "pending") throw new Auctioneer2ClientError(
      "Closing your part is awaiting confirmation. Retry Close my part before requesting Re-Open.",
      { statusCode: 409, code: "auctioneer_contract_close_pending_or_confirmed" });
    await assertNoQueuedContinuationUpload(id, userId);
    const unfinished = await AuctioneerWorkItem.exists({ "contract.id": id, claimedBy: userId,
      ...(previous?.accessRevision !== undefined ? { contractAccessRevision: previous.accessRevision } : {}),
      "delivery.status": { $in: ["queued", "sending", "failed", "needs_reconciliation"] } });
    if (unfinished) throw new Auctioneer2ClientError("Finish or resolve the existing delivery before reopening this contract.",
      { statusCode: 409, code: "auctioneer_contract_delivery_unfinished" });
    const attemptId = ["reopen_pending", "open"].includes(String(previous?.status)) && previous?.reopenAttemptId
      ? previous.reopenAttemptId : randomUUID();
    const cycleKey = previous?.reopenAttemptId === attemptId && previous?.reopenCycleKey
      ? previous.reopenCycleKey : createHash("sha256").update(`reopen:${id}:${userId}:${attemptId}`).digest("hex");
    await lease.assertOwned();
    await AuctioneerContractClose.updateOne({ _id: auctioneerContractStateId(id, userId) }, {
      $setOnInsert: { user: userId, contractId: id },
      $set: { status: "reopen_pending", reopenAttemptId: attemptId, reopenCycleKey: cycleKey },
    }, { upsert: true });
    let outcome;
    try {
      outcome = await reopenContractForUser(id, { userId,
        reopenedBy: String(user.username || user.email || `Asset Insight user ${userId}`) });
    } catch (error) {
      await lease.assertOwned();
      // Documented refusal proves no reopen happened. Unknown outcomes retain the
      // exact durable attempt and prevent delivery/close until explicit recovery.
      if (error instanceof Auctioneer2ClientError && error.upstreamStatus === 409) {
        await AuctioneerContractClose.updateOne({ _id: auctioneerContractStateId(id, userId), reopenAttemptId: attemptId }, {
          $set: { status: previous?.status === "open" ? "confirmed" : previous?.status || "confirmed" },
        });
      }
      throw error;
    }
    await lease.assertOwned();
    const confirmedCycleKey = createHash("sha256").update(JSON.stringify(["reopen", id, userId, outcome.accessRevision])).digest("hex");
    const updated = await AuctioneerContractClose.updateOne({ _id: auctioneerContractStateId(id, userId), reopenAttemptId: attemptId, status: "reopen_pending" }, {
      $set: { status: "open", accessRevision: outcome.accessRevision, reopenCycleKey: confirmedCycleKey, reopenedAt: new Date() },
    });
    if (updated.matchedCount !== 1) throw new Auctioneer2ClientError("Re-Open needs confirmation. Refresh Incoming and check the same request.",
      { statusCode: 409, code: "auctioneer_contract_reopen_pending" });
    const { clearAuctioneer2IncomingCacheForUser } = await import("./auctioneer2IntegrationService.js");
    clearAuctioneer2IncomingCacheForUser(userId);
    return outcome;
  });
}
