import { createHash } from "node:crypto";
import { ReportTransferDelivery } from "../models/reportTransfer.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import User from "../models/user.model.js";
import { uploadSessionRecoveryReceipt } from "../controller/reportUploadSession.controller.js";
import { notifyUser } from "./notificationService.js";
import { sendTransactionalEmail } from "../utils/sendVerificationEmail.js";

const html = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
let running = false;

export async function withReportTransferDeliveryDeadline<T>(operation: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Notification delivery could not be confirmed before its deadline.")), timeoutMs);
      timer.unref?.();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function notificationStillOwned(row: any) {
  const [session, owner] = await Promise.all([
    ReportUploadSession.findOne({ _id: row.sessionId, user: row.user, type: row.type })
      .select("status user reportId jobId clientSubmissionId cleanupStartedAt details.auctioneer_work_item_id +finalizationClaimToken").lean(),
    User.findById(row.user).select("email isBlocked").lean() as any,
  ]);
  if (!session || session.cleanupStartedAt || !owner || owner.isBlocked || owner.email !== row.recipient) return false;
  const receipt = await uploadSessionRecoveryReceipt({ type: row.type, session });
  return receipt.accepted && receipt.reportAvailable === true && receipt.reportId === row.reportId;
}

/** Recover a bounded batch of explicit submission receipts after API restarts.
 * This never accepts uploads, creates report jobs, or sends to client addresses.
 */
export async function recoverReportTransferNotifications() {
  if (running) return;
  running = true;
  try {
    const started = Date.now();
    const rows = await ReportTransferDelivery.find({ state: { $in: ["waiting", "accepted"] }, nextCheckAt: { $lte: new Date() } }).select("+recipient").sort({ readyAt: -1, nextCheckAt: 1, _id: 1 }).limit(25).lean() as any[];
    for (let row of rows) {
      if (Date.now() - started >= 60_000) break;
      // Fair scheduling: incomplete/offline captures cannot starve later work.
      await ReportTransferDelivery.updateOne({ _id: row._id }, { $set: { nextCheckAt: new Date(Date.now() + 30_000) } });
      try {
        const session = await ReportUploadSession.findOne({ _id: row.sessionId, user: row.user, type: row.type })
          .select("status user reportId jobId clientSubmissionId cleanupStartedAt details.contract_no details.auctioneer_work_item_id +finalizationClaimToken").lean();
        if (!session) {
          await ReportTransferDelivery.updateOne({ _id: row._id }, { $set: { state: "unavailable" } });
          continue;
        }
        // A terminal worker error does not undo its already accepted upload.
        // Only the exact receipt below can distinguish it from a failed upload.
        if (!session.reportId || !["completed", "queued", "processed", "failed"].includes(session.status)) {
          const checks = Math.min(4, Number(row.waitingChecks || 0) + 1);
          await ReportTransferDelivery.updateOne({ _id: row._id, state: "waiting", readyAt: { $exists: false } }, {
            $set: { waitingChecks: checks, nextCheckAt: new Date(Date.now() + Math.min(300_000, 30_000 * 2 ** checks)) },
          });
          continue;
        }
        const receipt = await uploadSessionRecoveryReceipt({ type: row.type, session });
        if (receipt.reportAvailable === false || session.cleanupStartedAt) {
          await ReportTransferDelivery.updateOne({ _id: row._id }, { $set: { state: "unavailable" } });
          continue;
        }
        if (!receipt.accepted || receipt.reportAvailable !== true || !receipt.reportId) continue;
        const owner = await User.findById(row.user).select("email isBlocked").lean() as any;
        if (!owner || owner.isBlocked || !owner.email) continue;
        if (row.state === "waiting") {
          await ReportTransferDelivery.updateOne({ _id: row._id, state: "waiting" }, { $set: { state: "accepted", acceptedAt: new Date(), reportId: receipt.reportId,
            recipient: owner.email, contract: String((session as any).details?.contract_no || "") } });
          row = await ReportTransferDelivery.findById(row._id).select("+recipient").lean();
        }
        // Do not deliver retained mail to a former account email after a change.
        if (!row || row.recipient !== owner.email || row.reportId !== receipt.reportId) continue;
        const reportType = row.type === "asset" ? "Asset Report" : "Lot Listing";
        const title = `${reportType} upload received`;
        const body = `${row.contract ? `Contract ${row.contract}: ` : ""}Your upload was received and queued for processing. ${receipt.status === "failed" ? "Report processing now needs attention." : "You will be notified when the preview is ready."} Open Previews to check its current status.`;
        if (!row.inboxSentAt) {
          const notificationId = createHash("sha256").update(`report-transfer-accepted:${row._id}`).digest("hex").slice(0, 24);
          try {
            if (!(await notificationStillOwned(row))) continue;
            await withReportTransferDeliveryDeadline(notifyUser({ userId: String(row.user), category: "report", type: "report_upload_accepted", title, body,
              notificationId, data: { reportId: row.reportId, reportType: row.type === "asset" ? "Asset" : "LotListing", sessionId: String(row.sessionId) } }));
            await ReportTransferDelivery.updateOne({ _id: row._id }, { $set: { inboxSentAt: new Date() } });
          } catch { /* The next sweep retries this exact deterministic inbox item. */ }
        }
        const claim = await ReportTransferDelivery.findOneAndUpdate({ _id: row._id, state: "accepted", emailState: "pending" }, {
          $set: { emailState: "sending", emailAttemptedAt: new Date() },
        }, { returnDocument: "after" }).lean();
        if (claim) {
          try {
            if (!(await notificationStillOwned(row))) {
              await ReportTransferDelivery.updateOne({ _id: row._id, emailState: "sending" }, { $set: { emailState: "pending", state: "unavailable" } });
              continue;
            }
            const providerMessageId = await withReportTransferDeliveryDeadline(sendTransactionalEmail({ to: row.recipient, subject: title,
              htmlContent: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>${html(title)}</h2><p>${html(body)}</p><p>Report ID: ${html(row.reportId)}</p></div>`,
              idempotencyKey: `report-transfer-accepted-${row._id}` }));
            await ReportTransferDelivery.updateOne({ _id: row._id, emailState: "sending" }, { $set: { emailState: "sent", emailSentAt: new Date(), providerMessageId } });
          } catch {
            // A network error cannot prove that the email was not delivered.
            // Keep the receipt, never repeat it blindly, and still retain inbox.
            await ReportTransferDelivery.updateOne({ _id: row._id, emailState: "sending" }, { $set: { emailState: "uncertain" } });
          }
        }
        await ReportTransferDelivery.updateOne({ _id: row._id, emailState: "sending", emailAttemptedAt: { $lt: new Date(Date.now() - 5 * 60_000) } }, { $set: { emailState: "uncertain" } });
        await ReportTransferDelivery.updateOne({ _id: row._id, inboxSentAt: { $ne: null }, emailState: { $in: ["sent", "uncertain"] } }, { $set: { state: "complete" } });
      } catch { /* Preserve durable intent; one failed row cannot starve peers. */ }
    }
  } finally { running = false; }
}
