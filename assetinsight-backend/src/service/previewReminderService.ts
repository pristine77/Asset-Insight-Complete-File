/**
 * Composes safe saved-preview guidance and delivers explicitly reviewed admin
 * messages through immutable receipts and a deterministic in-app inbox item.
 * The legacy internal sender retains caller-managed audit for scheduled/draft
 * reminders; the reviewed admin sender owns its delivery and parent audit.
 */
import { notifyUser } from "./notificationService.js";
import { sendEmail, sendTransactionalEmail } from "../utils/sendVerificationEmail.js";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportJob from "../models/reportJob.model.js";
import User from "../models/user.model.js";
import PreviewReminderDelivery from "../models/previewReminderDelivery.model.js";
import { getCanonicalLotListingPreview, hasSavedReportPreview } from "../utils/reportPreviewAvailability.js";
import { resolveReportGenerationState } from "../utils/reportFileState.js";
import { getMissingAssetConditionSelectionMessage } from "../utils/assetConditionSelections.js";
import { normalizePreviewLotNumbers } from "../utils/lotNumbers.js";
import { getPreviewLotPhotoLimitMessage } from "../utils/assetPhotoLimits.js";
import { sanitizeAssetPreviewSignature } from "../utils/assetPreviewSignature.js";

export type ReminderOwner = {
  _id?: unknown;
  username?: string | null;
  email?: string | null;
  companyName?: string | null;
  isBlocked?: boolean | null;
};

export type PreviewReminderEligibility = {
  eligible: boolean;
  reason: string | null;
};

export function getPreviewReminderEligibility(input: {
  workflowStage: string;
  previewSubmittedAt?: Date | string | null;
  approvalRequestedAt?: Date | string | null;
  owner?: ReminderOwner | null;
  allowFailed?: boolean;
  report?: any;
  hasActiveJob?: boolean;
  hasSavedPreview?: boolean;
}): PreviewReminderEligibility {
  const report = input.report || {};
  if (report.preview_reminder_claimed_at) {
    return { eligible: false, reason: "A scheduled reminder is awaiting completion. Wait for its delivery to finish before sending another notification." };
  }
  if (report.adminArchivedAt || report.is_draft_preview || ["draft", "archived"].includes(report.status)) {
    return { eligible: false, reason: "Archived reports and hidden draft previews cannot be notified here." };
  }
  const leaseLive = (token: unknown, expiry: unknown) => Boolean(token && (!expiry || new Date(expiry as any).getTime() > Date.now()));
  if (input.hasActiveJob || report.report_job_outbox || report.files_generating || report.files_regenerating ||
    report.files_regeneration_pending || report.excel_regenerating || report.proposal_valuation_regeneration_claim_token ||
    ["queued", "processing", "uploading"].includes(report.job_status) ||
    leaseLive(report.artifact_publish_token, report.artifact_publish_expires_at) ||
    leaseLive(report.proposal_valuation_artifact_publish_token, report.proposal_valuation_artifact_publish_expires_at)) {
    return { eligible: false, reason: "Wait for active processing to finish before notifying the owner." };
  }
  const failed = input.allowFailed === true && input.workflowStage === "error" && report.job_status === "error" && input.hasSavedPreview === true;
  if (!failed && (input.previewSubmittedAt || input.approvalRequestedAt)) {
    return { eligible: false, reason: "This preview has already been submitted." };
  }
  if (!failed && input.workflowStage !== "preview_ready") {
    return {
      eligible: false,
      reason: "Reminders can be sent after the preview is ready for the user to review.",
    };
  }
  if (!input.owner?._id) {
    return { eligible: false, reason: "This preview no longer has a valid owner." };
  }
  if (input.owner.isBlocked) {
    return { eligible: false, reason: "The preview owner is blocked." };
  }
  if (!/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(String(input.owner.email || "").trim())) {
    return { eligible: false, reason: "The preview owner does not have an email address." };
  }
  return { eligible: true, reason: null };
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ownerDisplay(owner: ReminderOwner) {
  return (
    String(owner.username || "").trim() ||
    String(owner.companyName || "").trim() ||
    String(owner.email || "").trim() ||
    "User"
  );
}

function messageParagraphs(message: string) {
  return message
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 14px;line-height:1.65;color:#374151">${escapeHtml(
          paragraph
        ).replace(/\n/g, "<br/>")}</p>`
    )
    .join("");
}

export function buildPreviewReminderEmailHtml(input: {
  owner: ReminderOwner;
  reportType: "Asset" | "LotListing";
  contractNo: string;
  waitingSince: Date;
  message: string;
  previewUrl: string;
  kind?: "draft" | "preview";
  heading?: string;
  buttonLabel?: string;
  includeGreeting?: boolean;
  reportError?: string;
  correctionSteps?: string[];
}) {
  const reportLabel = input.reportType === "Asset" ? "Asset Report" : "Lot Listing";
  const kind = input.kind === "draft" ? "draft" : "preview";
  const waitingLabel = new Intl.DateTimeFormat("en-CA", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/Regina",
  }).format(input.waitingSince);

  return `
    <div style="margin:0;background:#f4f6f8;padding:36px 16px;font-family:Arial,sans-serif;color:#111827;overflow-wrap:anywhere">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe3e8;border-radius:6px;overflow:hidden">
        <div style="height:5px;background:#e11d48"></div>
        <div style="padding:30px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.12em;color:#e11d48">ASSET INSIGHT</div>
          <h1 style="margin:12px 0 8px;font-size:25px;line-height:1.25">${escapeHtml(
            input.heading || `${kind === "draft" ? "Draft" : "Preview"} waiting for review`
          )}</h1>
          ${input.includeGreeting === false ? "" : `<p style="margin:0 0 22px;color:#6b7280">Hello ${escapeHtml(ownerDisplay(input.owner))},</p>`}
          ${messageParagraphs(input.message)}
          ${input.reportError ? `<section style="margin:22px 0;border:1px solid #dfe3e8;border-left:4px solid #e11d48;padding:16px;background:#f9fafb"><h2 style="margin:0 0 10px;font-size:17px">Saved report issue</h2><p style="margin:0 0 12px;line-height:1.6;overflow-wrap:anywhere">${escapeHtml(input.reportError)}</p>${input.correctionSteps?.length ? `<ol style="margin:0;padding-left:22px;line-height:1.6">${input.correctionSteps.map((step) => `<li style="margin-bottom:8px">${escapeHtml(step)}</li>`).join("")}</ol>` : ""}</section>` : ""}
          <table role="presentation" style="width:100%;table-layout:fixed;border-collapse:collapse;margin:22px 0;font-size:14px;line-height:1.5">
            <tr>
              <td style="width:35%;border:1px solid #e5e7eb;background:#f9fafb;padding:8px;font-weight:700">Report</td>
              <td style="border:1px solid #e5e7eb;padding:8px">${escapeHtml(reportLabel)}</td>
            </tr>
            <tr>
              <td style="border:1px solid #e5e7eb;background:#f9fafb;padding:8px;font-weight:700">Contract</td>
              <td style="border:1px solid #e5e7eb;padding:8px">${escapeHtml(input.contractNo || "Not provided")}</td>
            </tr>
            <tr>
              <td style="border:1px solid #e5e7eb;background:#f9fafb;padding:8px;font-weight:700">Waiting since</td>
              <td style="border:1px solid #e5e7eb;padding:8px">${escapeHtml(waitingLabel)}</td>
            </tr>
          </table>
          <a href="${escapeHtml(input.previewUrl)}" style="display:inline-block;background:#e11d48;color:#ffffff;text-decoration:none;padding:12px 19px;border-radius:4px;font-weight:700">${escapeHtml(
            input.buttonLabel || (kind === "draft" ? "Open draft" : "Review preview")
          )}</a>
          <p style="margin:24px 0 0;color:#6b7280;font-size:13px;line-height:1.5">This reminder was sent by Asset Insight Operations.</p>
        </div>
      </div>
    </div>
  `;
}

export async function sendPreviewReminder(input: {
  reportId: string;
  reportType: "Asset" | "LotListing";
  contractNo: string;
  waitingSince: Date;
  message: string;
  owner: ReminderOwner;
  kind?: "draft" | "preview";
  targetUrl?: string;
  notificationRoute?: string;
  notificationTitle?: string;
  notificationBody?: string;
}) {
  const email = String(input.owner.email || "").trim();
  const webUrl = String(
    process.env.WEB_APP_URL || process.env.CLIENT_URL || "http://localhost:3000"
  ).replace(/\/+$/, "");
  const previewType = input.reportType === "Asset" ? "asset" : "lotListing";
  const previewUrl = input.targetUrl || `${webUrl}/previews?reportId=${encodeURIComponent(
    input.reportId
  )}&reportType=${encodeURIComponent(previewType)}`;
  const kindLabel = input.kind === "draft" ? "Draft" : "Preview";
  const subject = `${kindLabel} reminder: ${input.contractNo || input.reportId}`;

  // Email delivery is authoritative for this action. The in-app notification
  // is supplemental and must not turn a successfully delivered email into an
  // apparent failure for the administrator.
  await sendEmail(
    email,
    subject,
    buildPreviewReminderEmailHtml({
      owner: input.owner,
      reportType: input.reportType,
      contractNo: input.contractNo,
      waitingSince: input.waitingSince,
      message: input.message,
      previewUrl,
      kind: input.kind,
    })
  );

  let notificationWarning = "";
  try {
    await notifyUser({
      userId: String(input.owner._id || ""),
      category: "report",
      type: "preview_review_reminder",
      title: input.notificationTitle || `${kindLabel} waiting for review`,
      body:
        input.notificationBody ||
        input.message,
      data: {
        subject,
        message: input.message,
        kind: input.kind || "preview",
        reportId: input.reportId,
        reportType: input.reportType,
        contractNo: input.contractNo,
        route: input.notificationRoute || (input.kind === "draft" ? "/drafts" : "/previews"),
      },
      pushBody: input.notificationBody || `${kindLabel} guidance is available. Open the notification to read the full message.`,
      pushData: { reportId: input.reportId, reportType: input.reportType, kind: input.kind || "preview",
        route: input.notificationRoute || (input.kind === "draft" ? "/drafts" : "/previews") },
    });
  } catch (error: any) {
    notificationWarning = "The in-app notification could not be confirmed.";
  }

  return { subject, previewUrl, notificationWarning };
}

type ReportType = "Asset" | "LotListing";
const reportModel = (type: ReportType): any => type === "Asset" ? AssetReport : LotListing;
const fail = (statusCode: number, message: string, code: string) => Object.assign(new Error(message), { statusCode, code });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (owner: any) => String(owner?._id || owner || "");

function savedReminderPreview(type: ReportType, report: any) {
  if (type === "Asset") return report.preview_data;
  return getCanonicalLotListingPreview(report) ?? { ...report, lots: report.lots };
}

function reminderRevision(type: ReportType, report: any) {
  // Reminder audit timestamps do not invalidate a correction draft; changes to
  // owner, error, workflow or saved input do. No internal diagnostic is exposed.
  return digest({ type, id: String(report._id), owner: identity(report.user), email: report.user?.email,
    blocked: report.user?.isBlocked, status: report.status, release: report.release_status,
    job: report.job_id, jobStatus: report.job_status, error: report.job_error, errorMessage: report.error_message,
    submitted: report.preview_submitted_at, requested: report.approval_requested_at,
    archived: report.adminArchivedAt, draft: report.is_draft_preview,
    // Scheduled sends always checkpoint delivered recipient IDs before marking
    // completion. These fields change without updatedAt; manual audit does not
    // touch them, so an accepted manual receipt remains safely deduplicable.
    scheduledClaim: report.preview_reminder_claimed_at,
    scheduledRecipients: report.preview_reminder_recipient_ids,
    scheduledError: report.preview_reminder_error,
    preview: savedReminderPreview(type, report), pvRevision: report.proposal_valuation_revision });
}

function safeGuidance(type: ReportType, report: any) {
  const preview = savedReminderPreview(type, report) || {};
  const rawError = String(report.job_error || report.error_message || "");
  const currentIssue = (type === "Asset" ? getMissingAssetConditionSelectionMessage(preview.lots || []) : null) ||
    normalizePreviewLotNumbers(preview, preview).message || getPreviewLotPhotoLimitMessage(preview) ||
    (type === "Asset" ? sanitizeAssetPreviewSignature(preview).message : null);
  if (currentIssue) return { reportError: currentIssue, affectedLots: [], correctionSteps: [
    "Open this report in Previews and correct the saved-data issue shown above.",
    type === "Asset"
      ? "Complete required condition selections accurately (use N/A only when appropriate), keep lot numbers distinct, and review all saved details."
      : "Keep lot numbers distinct and review all saved lot details and photos. FMV and appraisal condition selections are not required for Lot Listing.",
    "Save the corrections, then select Save and resubmit / Regenerate report once and wait for file generation to finish.",
  ] };
  if (type === "LotListing" && /^(Please enter FMV for Lot |Please select (Running Condition|Completeness|Legal))/i.test(rawError)) return {
    reportError: "The previous generation stopped under an older Lot Listing requirement. FMV and appraisal condition selections are now optional; the saved preview can be reviewed and regenerated.",
    affectedLots: [], correctionSteps: [
      "Open the saved preview and review every lot, description and photo. Existing saved values are retained; do not enter placeholder values.",
      "If the saved corrections are complete, select Save and resubmit / Regenerate report and wait for file generation to finish.",
      "If generation fails again, send the new message and report number to Asset Insight Operations.",
    ],
  };
  if (report.job_status === "error") return {
    reportError: "The latest report file generation did not complete. This message does not establish that any user-entered value is incorrect; Operations can review the technical diagnostics.",
    affectedLots: [], correctionSteps: [
      type === "Asset"
        ? "Open this report in Previews. Review all saved lots, descriptions, values and required condition selections."
        : "Open this report in Previews. Review all saved lots, descriptions and photos; FMV and appraisal condition selections are optional.",
      "Contact Asset Insight Operations with the report number so the processing failure can be checked.",
      "When Operations confirms the issue is resolved, resubmit once and wait for processing to finish. Do not repeatedly submit the same report.",
    ],
  };
  return { reportError: "", affectedLots: [], correctionSteps: [
    type === "Asset"
      ? "Open the saved report in Previews and review every lot, description, value and required selection."
      : "Open the saved report in Previews and review every lot, description and photo. FMV and appraisal condition selections are optional.",
    "Save any corrections, then submit the preview when your review is complete.",
  ] };
}

function safeSubject(value: unknown) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 180);
}

function deliveryStatus(delivery: any): "processing" | "sent" | "uncertain" {
  if (delivery.state === "sent") return "sent";
  if (delivery.state === "uncertain" || new Date(delivery.attemptedAt || delivery.createdAt).getTime() < Date.now() - 2 * 60_000) return "uncertain";
  return "processing";
}

async function loadReminderReport(reportId: string) {
  const fields = "+report_job_outbox +preview_reminder_delivery_id";
  const [asset, listing] = await Promise.all([
    AssetReport.findById(reportId).select(fields).populate("user", "username email companyName isBlocked").lean(),
    LotListing.findById(reportId).select(fields).populate("user", "username email companyName isBlocked").lean(),
  ]);
  const report = asset || listing;
  if (!report) throw fail(404, "Preview report not found.", "REPORT_NOT_FOUND");
  return { report: report as any, type: (asset ? "Asset" : "LotListing") as ReportType };
}

async function reminderState(type: ReportType, report: any) {
  const workflow = resolveReportGenerationState(report, report.preview_files, report.files);
  const hasActiveJob = Boolean(await ReportJob.exists({ reportId: String(report._id), status: { $in: ["queued", "processing"] } }));
  return getPreviewReminderEligibility({ workflowStage: workflow.workflow_stage, previewSubmittedAt: report.preview_submitted_at,
    approvalRequestedAt: report.approval_requested_at, owner: report.user, report, hasActiveJob,
    allowFailed: true, hasSavedPreview: hasSavedReportPreview(type === "Asset" ? "asset" : "lotListing", report) });
}

/** Side-effect-free composition from current saved data or a frozen pending send. */
export async function getAdminPreviewReminderDraft(reportId: string) {
  const { type, report } = await loadReminderReport(reportId);
  const eligibility = await reminderState(type, report);
  const contractNo = String(report.contract_no || report.preview_data?.contract_no || "");
  const guidance = safeGuidance(type, report);
  const recipient = { id: identity(report.user), displayName: ownerDisplay(report.user || {}), email: String(report.user?.email || "") };
  const label = type === "Asset" ? "Asset Report" : "Lot Listing";
  const subject = safeSubject(`${guidance.reportError ? "Action required" : "Review reminder"}: ${label} ${contractNo || reportId}`);
  const message = `Hello ${recipient.displayName.slice(0, 160)},\n\n${guidance.reportError ? `Your ${label} report ${(contractNo || reportId).slice(0, 200)} needs attention before its files can be generated.\n\nThe report issue and correction steps are included below. Open the related preview, review the required corrections, then save and submit again when the issue is resolved.` : `Your ${label} report ${(contractNo || reportId).slice(0, 200)} is ready for your review.\n\nOpen the saved preview, review all details and make any necessary corrections. Save and submit it when your review is complete.`}\n\nThank you,\nAsset Insight Operations`;
  const draft: any = { reportId, reportType: type, contractNo, recipient, subject, message, baseRevision: reminderRevision(type, report),
    eligible: eligibility.eligible, ineligibleReason: eligibility.reason, ...guidance, lastSentAt: report.preview_reminder_sent_at || null };
  if (report.preview_reminder_delivery_id) {
    const pending: any = await PreviewReminderDelivery.findById(report.preview_reminder_delivery_id).lean();
    if (pending && (["reserved", "processing", "uncertain"].includes(pending.state) || (pending.state === "sent" && pending.notificationStatus !== "sent"))) {
      Object.assign(draft, { recipient: pending.recipient, subject: pending.subject, message: pending.message,
        baseRevision: pending.baseRevision, reportError: pending.reportError, correctionSteps: pending.correctionSteps,
        affectedLots: pending.affectedLots, pendingDelivery: { requestId: pending.requestId, status: pending.state === "sent" ? "uncertain" : deliveryStatus(pending),
          deliveryStatus: deliveryStatus(pending), inAppStatus: pending.notificationStatus || "pending" } });
    }
  }
  return draft;
}

function reminderClaim(report: any) {
  const exact = (key: string) => ({ [key]: report[key] === undefined ? { $exists: false } : report[key] });
  return { _id: report._id, user: identity(report.user),
    $and: [
      ...["updatedAt", "status", "job_id", "job_status", "job_error", "error_message", "preview_submitted_at", "approval_requested_at",
        "preview_reminder_claimed_at", "preview_reminder_sent_at", "preview_reminder_recipient_ids", "preview_reminder_error",
        "files_generating", "files_regenerating", "excel_regenerating", "files_regeneration_pending", "adminArchivedAt", "is_draft_preview", "preview_reminder_delivery_id",
        "artifact_publish_token", "artifact_publish_expires_at", "proposal_valuation_artifact_publish_token", "proposal_valuation_artifact_publish_expires_at",
        "proposal_valuation_regeneration_claim_token"].map(exact),
      report.preview_data === undefined ? { preview_data: { $exists: false } }
        : { $expr: { $eq: ["$preview_data", { $literal: report.preview_data }] } },
      report.lots === undefined ? { lots: { $exists: false } }
        : { $expr: { $eq: ["$lots", { $literal: report.lots }] } },
      { $or: [{ report_job_outbox: null }, { report_job_outbox: { $exists: false } }] },
    ] };
}

async function ensureReminderNotification(delivery: any) {
  if (delivery.notificationStatus === "sent" || !["sent", "uncertain"].includes(delivery.state)) return;
  try {
    await notifyUser({ notificationId: String(delivery.notificationId),
      userId: delivery.recipient.id, category: "report", type: "preview_review_reminder", title: delivery.subject, body: delivery.message,
      data: { subject: delivery.subject, message: delivery.message, reportError: delivery.reportError, correctionSteps: delivery.correctionSteps,
        reportId: delivery.reportId, reportType: delivery.reportType, contractNo: delivery.contractNo, kind: "preview", route: "/previews", reminderRequestId: delivery.requestId },
      pushBody: "Asset Insight Operations sent report guidance. Open this notification to read the full message.",
      pushData: { reportId: delivery.reportId, reportType: delivery.reportType, route: "/previews" },
    });
    await PreviewReminderDelivery.updateOne({ _id: delivery._id }, { $set: { notificationStatus: "sent" } });
    delivery.notificationStatus = "sent";
  } catch {
    await PreviewReminderDelivery.updateOne({ _id: delivery._id }, { $set: { notificationStatus: "uncertain" } }).catch(() => undefined);
    delivery.notificationStatus = "uncertain";
  }
}

function deliveryResponse(delivery: any) {
  const status = deliveryStatus(delivery);
  return { statusCode: status === "sent" ? 200 : 202, body: { deliveryStatus: status, inAppStatus: delivery.notificationStatus || "pending",
    requestId: delivery.requestId, recipient: delivery.recipient, sentAt: delivery.sentAt || null,
    message: status === "sent" ? (delivery.notificationStatus === "sent" ? "Email sent and full guidance added to the owner's in-app notifications." : "Email sent. In-app delivery could not yet be confirmed; check this same request again.")
      : status === "uncertain" ? "Email delivery could not be confirmed. Do not send another email until this delivery has been checked. The same request will not resend it."
        : "The reviewed notification is being processed. Check this same request to confirm delivery; do not send another email." } };
}

/** One accepted provider attempt per immutable, reviewed request. */
export async function sendReviewedAdminPreviewReminder(input: { reportId: string; actorId: string; subject: string; message: string; baseRevision: string; requestId: string }) {
  const id = digest({ reportId: input.reportId, requestId: input.requestId });
  const contentHash = digest({ subject: input.subject, message: input.message });
  const prior: any = await PreviewReminderDelivery.findById(id).lean();
  if (prior) {
    // The route still requires a current superadmin. Another superadmin may
    // check the same frozen send, but cannot alter its original actor/content.
    if (prior.contentHash !== contentHash || prior.baseRevision !== input.baseRevision) throw fail(409, "This request ID belongs to a different reviewed message. Reload the notification draft.", "REMINDER_REQUEST_CONFLICT");
    if (prior.state === "rejected") throw fail(409, "This report changed before the notification was accepted. Reload and review the current draft.", "REMINDER_REVISION_CONFLICT");
    await ensureReminderNotification(prior);
    return deliveryResponse(prior);
  }
  const { report, type } = await loadReminderReport(input.reportId);
  if (reminderRevision(type, report) !== input.baseRevision) throw fail(409, "The report, error or owner changed. Reload and review the current notification draft.", "REMINDER_REVISION_CONFLICT");
  const eligibility = await reminderState(type, report);
  if (!eligibility.eligible) throw fail(409, eligibility.reason!, "REMINDER_NOT_ACTIONABLE");
  if (report.preview_reminder_delivery_id) {
    const pending: any = await PreviewReminderDelivery.findById(report.preview_reminder_delivery_id).lean();
    if (pending && (["reserved", "processing", "uncertain"].includes(pending.state) || (pending.state === "sent" && pending.notificationStatus !== "sent"))) {
      throw Object.assign(fail(409, "A notification delivery is already pending. Check the existing request; do not send another email.", "REMINDER_DELIVERY_PENDING"),
        { pendingDelivery: { requestId: pending.requestId, status: pending.state === "sent" ? "uncertain" : deliveryStatus(pending) } });
    }
  }
  // A fresh browser ID is not permission to resend unchanged guidance.
  const duplicate: any = await PreviewReminderDelivery.findOne({ reportId: input.reportId, baseRevision: input.baseRevision, contentHash, state: { $in: ["processing", "sent", "uncertain"] } }).lean();
  if (duplicate) { await ensureReminderNotification(duplicate); return deliveryResponse(duplicate); }
  const guidance = safeGuidance(type, report);
  const recipient = { id: identity(report.user), displayName: ownerDisplay(report.user), email: String(report.user.email).trim() };
  const now = new Date();
  const value = { _id: id, requestId: input.requestId, reportId: input.reportId, reportType: type, actorId: input.actorId,
    subject: input.subject, message: input.message, baseRevision: input.baseRevision, contentHash, recipient,
    contractNo: String(report.contract_no || report.preview_data?.contract_no || ""), ...guidance,
    waitingSince: report.processing_completed_at || report.updatedAt || report.createdAt || now,
    state: "reserved", notificationId: new mongoose.Types.ObjectId(id.slice(0, 24)), notificationStatus: "pending" };
  try { await PreviewReminderDelivery.create(value); }
  catch (error: any) {
    if (error?.code === 11000) return sendReviewedAdminPreviewReminder(input);
    throw error;
  }
  const claimed = await reportModel(type).updateOne(reminderClaim(report), { $set: { preview_reminder_delivery_id: id } });
  if (claimed.matchedCount !== 1) {
    await PreviewReminderDelivery.updateOne({ _id: id }, { $set: { state: "rejected", errorCode: "REMINDER_REVISION_CONFLICT" } });
    throw fail(409, "The report changed while the notification was being accepted. Reload and review it.", "REMINDER_REVISION_CONFLICT");
  }
  // Persist the point of no automatic retry before entering the provider.
  await PreviewReminderDelivery.updateOne({ _id: id, state: "reserved" }, { $set: { state: "processing", attemptedAt: now } });
  const currentOwner = await User.findOne({ _id: recipient.id, isBlocked: { $ne: true }, email: recipient.email }).select("_id").lean();
  const sameOwner = await reportModel(type).exists({ _id: report._id, user: recipient.id, preview_reminder_delivery_id: id });
  if (!currentOwner || !sameOwner) {
    await PreviewReminderDelivery.updateOne({ _id: id }, { $set: { state: "rejected", errorCode: "REMINDER_REVISION_CONFLICT" } });
    throw fail(409, "The owner changed before delivery. Reload and review the notification draft.", "REMINDER_REVISION_CONFLICT");
  }
  const webUrl = String(process.env.WEB_APP_URL || process.env.CLIENT_URL || "http://localhost:3000").replace(/\/+$/, "");
  const previewUrl = `${webUrl}/previews?reportId=${encodeURIComponent(input.reportId)}&reportType=${type === "Asset" ? "asset" : "lotListing"}`;
  let sentAt: Date | undefined;
  let providerMessageId: string | null = null;
  try {
    providerMessageId = await sendTransactionalEmail({ to: recipient.email, subject: input.subject, idempotencyKey: `preview-reminder-${id}`,
      htmlContent: buildPreviewReminderEmailHtml({ owner: report.user, reportType: type, contractNo: value.contractNo,
        waitingSince: new Date(value.waitingSince), message: input.message, previewUrl, includeGreeting: false,
        heading: guidance.reportError ? "Report needs attention" : "Preview waiting for review", ...guidance }) });
    if (providerMessageId) sentAt = new Date();
  } catch {
    // A timeout may follow provider acceptance. Never retry or fall back to a
    // second email; the durable receipt stays quarantined for operator review.
  }
  const delivered: any = { ...value, state: sentAt ? "sent" : "uncertain", sentAt, providerMessageId, attemptedAt: now };
  try {
    await PreviewReminderDelivery.updateOne({ _id: id }, { $set: { state: delivered.state, ...(sentAt ? { sentAt, providerMessageId } : { errorCode: "EMAIL_DELIVERY_UNCERTAIN" }) } });
  } catch {
    // Even a successful provider response cannot be called durable success if
    // its receipt was lost. The processing marker prevents an automatic resend.
    delivered.state = "uncertain";
  }
  await ensureReminderNotification(delivered);
  if (sentAt) {
    await reportModel(type).updateOne({ _id: report._id, user: recipient.id, preview_reminder_delivery_id: id }, {
      $set: { preview_reminder_sent_at: sentAt, preview_reminder_sent_by: input.actorId, preview_reminder_message: input.message },
    }).catch(() => undefined);
  }
  return deliveryResponse(delivered);
}
