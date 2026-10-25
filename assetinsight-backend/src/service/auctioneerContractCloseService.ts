import { createHash } from "node:crypto";
import AuctioneerContractClose from "../models/auctioneerContractClose.model.js";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import { withReportSubmissionAdmission, type ReportSubmissionAdmissionLease } from "./reportSubmissionAdmissionService.js";
import { Auctioneer2ClientError } from "./auctioneer2Client.js";

export const auctioneerContractStateId = (contractId: string, userId: string) => createHash("sha256")
  .update(JSON.stringify([contractId, userId])).digest("hex");
const identity = auctioneerContractStateId;

/** Same durable admission namespace for Asset and Lot Listing on this contract. */
export function withAuctioneerContractOperation<T>(
  contractId: string,
  userId: string,
  work: (lease: ReportSubmissionAdmissionLease) => Promise<T>,
): Promise<T> {
  return withReportSubmissionAdmission({
    reportType: "asset",
    userId,
    contractClaim: `auctioneer-contract-operation:${identity(contractId, userId)}`,
  }, async (lease) => {
    if (!lease) throw new Error("Auctioneer contract admission was not acquired.");
    await lease.assertOwned();
    return work(lease);
  }).catch((error) => {
    if (String(error?.code || "").startsWith("REPORT_SUBMISSION_ADMISSION_")) {
      throw new Auctioneer2ClientError("Another delivery or close is in progress for this contract. Wait and retry the same action.",
        { statusCode: 409, code: "auctioneer_contract_operation_busy" });
    }
    throw error;
  });
}

export async function getAuctioneerContractCaptureState(contractId: string, userId: string) {
  return AuctioneerContractClose.findById(identity(contractId, userId)).lean();
}

export async function assertAuctioneerContractCaptureRevision(contractId: string, userId: string, revision?: string | number) {
  const state = await getAuctioneerContractCaptureState(contractId, userId);
  if (state?.accessRevision !== undefined && state.accessRevision !== revision) throw new Auctioneer2ClientError(
    "This capture belongs to an earlier opening of the contract. Refresh Incoming and use its current capture; your existing report and photos are retained.",
    { statusCode: 409, code: "auctioneer_contract_capture_changed" });
  if (state?.status === "reopen_pending") throw new Auctioneer2ClientError(
    "Re-Open is awaiting confirmation. Retry the same Re-Open action before sending or closing more work.",
    { statusCode: 409, code: "auctioneer_contract_reopen_pending" });
  return state;
}

export async function assertAuctioneerContractSendOpen(contractId: string, userId: string, revision?: string | number) {
  const close = await assertAuctioneerContractCaptureRevision(contractId, userId, revision);
  if (close?.status === "open") return;
  if (close) throw new Auctioneer2ClientError(
    (close as any).status === "confirmed"
      ? "Your part of this contract is already closed or its assignment was removed. Ask the auction team to review it before sending more lots."
      : "Closing your part of this contract is awaiting confirmation. Retry Close my part before sending more lots; the existing reports and photos are unchanged.",
    { statusCode: 409, code: "auctioneer_contract_close_pending_or_confirmed" });
}

/** Called inside the same contract-operation lease as reservation/close. Only
 * explicit queued-continuation intents add this new fence; ordinary claims keep
 * their existing close policy. Missing receipts retain the fence, never expire. */
export async function assertNoQueuedContinuationUpload(contractId: string, userId: string) {
  const captureState = await getAuctioneerContractCaptureState(contractId, userId);
  const parents = AuctioneerWorkItem.find({ "contract.id": contractId, claimedBy: userId,
    ...(captureState?.accessRevision !== undefined ? { contractAccessRevision: captureState.accessRevision } : {}),
    assignmentUserId: userId, queuedContinuation: { $exists: true } }).select({ selectedReportType: 1, queuedContinuation: 1 }).lean().cursor({ batchSize: 25 });
  let blocked = false;
  const { uploadSessionRecoveryReceipt } = await import("../controller/reportUploadSession.controller.js");
  try { for await (const parent of parents) {
    const session = await ReportUploadSession.findOne({ _id: parent.queuedContinuation?.sessionId, user: userId, type: parent.selectedReportType })
      .select("status user reportId jobId clientSubmissionId cleanupStartedAt details.auctioneer_work_item_id +finalizationClaimToken").lean();
    if (!session || session.cleanupStartedAt) { blocked = true; break; }
    const receipt = await uploadSessionRecoveryReceipt({ type: parent.selectedReportType, session });
    if (!receipt.accepted || receipt.reportAvailable !== true) { blocked = true; break; }
  } } finally { await parents.close(); }
  if (blocked) throw new Auctioneer2ClientError("A capture with a reserved next lot is still uploading or awaiting confirmation. Finish or resume that exact queued capture before closing your part.",
    { statusCode: 409, code: "auctioneer_queued_upload_unfinished" });
}

/** Must be durable BEFORE the provider write; uncertainty keeps future sends fenced. */
export async function beginAuctioneerContractClose(contractId: string, userId: string) {
  const state = await getAuctioneerContractCaptureState(contractId, userId);
  if (state?.status === "reopen_pending") throw new Auctioneer2ClientError(
    "Re-Open is awaiting confirmation. Retry Re-Open before closing your part again.",
    { statusCode: 409, code: "auctioneer_contract_reopen_pending" });
  await AuctioneerContractClose.updateOne({ _id: identity(contractId, userId) }, {
    $setOnInsert: { user: userId, contractId }, $set: { status: "pending" },
  }, { upsert: true });
}

export async function confirmAuctioneerContractClose(
  contractId: string,
  userId: string,
  outcome: { taskCompleted: boolean; userStatus: string | null },
  closedAt: Date,
) {
  await AuctioneerContractClose.updateOne({ _id: identity(contractId, userId) }, {
    $set: { status: "confirmed", closedAt, taskCompleted: outcome.taskCompleted,
      userStatus: outcome.userStatus || null },
  });
}
