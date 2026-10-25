/**
 * Notifies the report owner after a durable job exhausts retries and records the
 * job-level failure-notification marker. Report generation flags and failure state are
 * managed by the job workflow, not by this notification service.
 */
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportJob, { type IReportJob } from "../models/reportJob.model.js";
import { notifyUser } from "./notificationService.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Notify an owner at most once after a durable job exhausts its retries. Claim
 * the job-level marker before the external side effect: a process crash after
 * an email provider accepts the message must not make lease reconciliation send
 * the same user-visible failure again.
 */
export async function notifyReportProcessingFailure(
  job: IReportJob,
  errorMessage: string
): Promise<void> {
  if (!job.reportId || job.failureNotificationSentAt) return;

  const isLotListing = job.type.startsWith("lot-listing");
  const report = isLotListing
    ? await LotListing.findById(job.reportId).populate("user").lean<any>()
    : await AssetReport.findById(job.reportId).populate("user").lean<any>();
  const owner = report?.user;
  if (!owner?._id || !owner?.email) return;

  const claimedAt = new Date();
  const claimed = await ReportJob.findOneAndUpdate(
    {
      _id: job._id,
      $or: [
        { failureNotificationSentAt: { $exists: false } },
        { failureNotificationSentAt: null },
      ],
    },
    { $set: { failureNotificationSentAt: claimedAt } },
    { returnDocument: "after" },
  );
  if (!claimed) return;

  const reportType = isLotListing ? "Lot Listing" : "Asset Report";
  const contract = String(
    report?.contract_no || report?.preview_data?.contract_no || "Not provided"
  );
  const stage = String(job.progress?.stage || job.progress?.phase || "processing");
  const webUrl = process.env.WEB_APP_URL || process.env.CLIENT_URL || "http://localhost:3000";
  const retryUrl = `${webUrl}/previews?highlight=${encodeURIComponent(String(job.reportId))}`;
  const safeMessage = escapeHtml(errorMessage || "Report processing failed.");

  await sendEmail(
    owner.email,
    `${reportType} Processing Error`,
    `<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:auto;color:#111827;line-height:1.6">
      <h2 style="color:#b91c1c">Your report needs attention</h2>
      <p>Processing stopped after all automatic retry attempts.</p>
      <table style="border-collapse:collapse;width:100%;margin:18px 0">
        <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700">Report</td><td style="padding:8px;border:1px solid #e5e7eb">${reportType}</td></tr>
        <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700">Contract</td><td style="padding:8px;border:1px solid #e5e7eb">${escapeHtml(contract)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700">Stage</td><td style="padding:8px;border:1px solid #e5e7eb">${escapeHtml(stage.replace(/_/g, " "))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700">Message</td><td style="padding:8px;border:1px solid #e5e7eb">${safeMessage}</td></tr>
      </table>
      <p><a href="${retryUrl}" style="display:inline-block;background:#2563eb;color:white;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:700">Review and retry</a></p>
      <p style="color:#6b7280;font-size:13px">Report ID: ${escapeHtml(job.reportId)}</p>
    </div>`
  );

  await notifyUser({
    userId: String(owner._id),
    tokens: Array.isArray(owner.expoPushTokens) ? owner.expoPushTokens : [],
    category: "report",
    type: "report_processing_failed",
    title: `${reportType} needs attention`,
    body: `Contract ${contract}: ${errorMessage || "Processing failed."}`,
    data: {
      type: "report_processing_failed",
      reportId: String(job.reportId),
      reportType: isLotListing ? "LotListing" : "Asset",
    },
  }).catch((error) => {
    console.error("[ReportFailureNotification] Push notification failed:", error);
  });
}
