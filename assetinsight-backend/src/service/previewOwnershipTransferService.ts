/**
 * Stable unsubmitted previews and failed file submissions may change owner.
 * Active work and successful publication remain protected. A failed transfer is
 * a return to manual review, never an instruction to generate or publish files.
 */
import { notifyUser } from "./notificationService.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";
import { getCanonicalLotListingPreview } from "../utils/reportPreviewAvailability.js";

type TransferUser = {
  _id?: unknown;
  username?: string | null;
  email?: string | null;
  companyName?: string | null;
};

type TransferEligibilityInput = {
  status?: string;
  job_status?: string;
  files_generating?: boolean;
  files_regenerating?: boolean;
  preview_submitted_at?: Date | string | null;
  approval_requested_at?: Date | string | null;
  lotCount?: number;
  validSavedLots?: boolean;
  adminArchivedAt?: unknown;
  is_draft_preview?: boolean;
  files_regeneration_pending?: boolean;
  excel_regenerating?: boolean;
  proposal_valuation_regeneration_claim_token?: string;
  report_job_outbox?: unknown;
  hasActiveJob?: boolean;
  artifact_publish_token?: string;
  artifact_publish_expires_at?: Date | string;
  proposal_valuation_artifact_publish_token?: string;
  proposal_valuation_artifact_publish_expires_at?: Date | string;
};

export type PreviewTransferEligibility = {
  eligible: boolean;
  reason: string | null;
};

export function savedLotsForPreviewTransfer(kind: "asset" | "lotListing", report: any): any[] {
  const preview = kind === "lotListing" ? getCanonicalLotListingPreview(report) : report?.preview_data;
  const lots = preview != null ? preview.lots : kind === "lotListing" ? report?.lots : undefined;
  return Array.isArray(lots) ? lots : [];
}

export function hasValidLotsForPreviewTransfer(lots: any[]): boolean {
  // Ownership transfer does not publish a report. The recipient may need to
  // complete a saved photo-only row; normal resubmit validation remains intact.
  return lots.length > 0 && lots.every((lot) => lot && typeof lot === "object" && !Array.isArray(lot) && Object.keys(lot).length > 0);
}

export function isFailedSubmittedPreview(report: TransferEligibilityInput): boolean {
  return report.job_status === "error" &&
    ["preview", "error", "processing", "pending_approval", "approved"].includes(String(report.status || "")) &&
    Boolean(report.preview_submitted_at || report.approval_requested_at ||
      ["pending_approval", "approved"].includes(String(report.status || "")));
}

function hasPublicationLease(token: unknown, expiresAt: unknown): boolean {
  if (!token) return false;
  const expiry = new Date(expiresAt as any).getTime();
  return !Number.isFinite(expiry) || expiry > Date.now();
}

export function getPreviewTransferEligibility(
  report: TransferEligibilityInput
): PreviewTransferEligibility {
  if (report.adminArchivedAt || report.is_draft_preview || ["archived", "draft"].includes(String(report.status || ""))) {
    return {
      eligible: false,
      reason: "Archived reports and saved draft previews cannot be reassigned here.",
    };
  }
  if (report.files_generating || report.files_regenerating || report.files_regeneration_pending ||
    report.excel_regenerating || report.proposal_valuation_regeneration_claim_token) {
    return {
      eligible: false,
      reason: "Wait for file generation to finish before reassigning this preview.",
    };
  }
  if (report.job_status === "queued" || report.job_status === "processing" ||
    report.hasActiveJob || report.report_job_outbox ||
    hasPublicationLease(report.artifact_publish_token, report.artifact_publish_expires_at) ||
    hasPublicationLease(report.proposal_valuation_artifact_publish_token, report.proposal_valuation_artifact_publish_expires_at)) {
    return {
      eligible: false,
      reason: "Wait for preview processing to finish before reassigning it.",
    };
  }
  const failedSubmission = isFailedSubmittedPreview(report);
  if (!failedSubmission && (report.preview_submitted_at || report.approval_requested_at ||
    !["preview", "declined", "error"].includes(String(report.status || "")))) {
    return {
      eligible: false,
      reason: "Only stable unsubmitted previews or failed file submissions can be reassigned.",
    };
  }
  if (report.validSavedLots === false || !Number.isFinite(report.lotCount) || Number(report.lotCount) < 1) {
    return {
      eligible: false,
      reason: "This preview has no saved lots to transfer.",
    };
  }
  return { eligible: true, reason: null };
}

function userDisplay(user: TransferUser) {
  return (
    String(user.username || "").trim() ||
    String(user.companyName || "").trim() ||
    String(user.email || "").trim() ||
    "User"
  );
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function transferEmailHtml(input: {
  heading: string;
  message: string;
  contractNo: string;
  reportType: "Asset" | "LotListing";
  previewUrl: string;
}) {
  const typeLabel = input.reportType === "Asset" ? "Asset Report" : "Lot Listing";
  return `
    <div style="margin:0;background:#f5f7fa;padding:32px 16px;font-family:Arial,sans-serif;color:#111827">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb">
        <div style="border-top:5px solid #e11d48;padding:28px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.12em;color:#e11d48">ASSET INSIGHT</div>
          <h1 style="margin:12px 0 8px;font-size:24px">${escapeHtml(input.heading)}</h1>
          <p style="margin:0 0 22px;line-height:1.6;color:#4b5563">${escapeHtml(input.message)}</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:22px">
            <tr>
              <td style="border:1px solid #e5e7eb;padding:10px;font-weight:700">Report</td>
              <td style="border:1px solid #e5e7eb;padding:10px">${escapeHtml(typeLabel)}</td>
            </tr>
            <tr>
              <td style="border:1px solid #e5e7eb;padding:10px;font-weight:700">Contract</td>
              <td style="border:1px solid #e5e7eb;padding:10px">${escapeHtml(input.contractNo || "Not provided")}</td>
            </tr>
          </table>
          <a href="${escapeHtml(input.previewUrl)}" style="display:inline-block;background:#e11d48;color:#ffffff;text-decoration:none;padding:11px 18px;font-weight:700">Open Previews</a>
        </div>
      </div>
    </div>
  `;
}

export async function notifyPreviewOwnershipTransfer(input: {
  reportId: string;
  reportType: "Asset" | "LotListing";
  contractNo: string;
  fromUser: TransferUser;
  toUser: TransferUser;
  transferredBy: TransferUser;
}) {
  const fromId = String(input.fromUser._id || "");
  const toId = String(input.toUser._id || "");
  const fromName = userDisplay(input.fromUser);
  const toName = userDisplay(input.toUser);
  const adminName = userDisplay(input.transferredBy);
  const webUrl = String(
    process.env.WEB_APP_URL || process.env.CLIENT_URL || "http://localhost:3000"
  ).replace(/\/+$/, "");
  const previewUrl = `${webUrl}/previews?highlight=${encodeURIComponent(input.reportId)}`;
  const reportType = input.reportType === "Asset" ? "Asset report" : "Lot Listing";

  const tasks: Array<Promise<unknown>> = [
    notifyUser({
      userId: fromId,
      category: "report",
      type: "preview_transferred_out",
      title: "Preview reassigned",
      body: `${reportType} ${input.contractNo || input.reportId} was reassigned to ${toName}.`,
      data: {
        reportId: input.reportId,
        reportType: input.reportType,
        contractNo: input.contractNo,
        route: "/previews",
        transferDirection: "out",
      },
    }),
    notifyUser({
      userId: toId,
      category: "report",
      type: "preview_transferred_in",
      title: "Preview assigned to you",
      body: `${reportType} ${input.contractNo || input.reportId} was transferred from ${fromName}.`,
      data: {
        reportId: input.reportId,
        reportType: input.reportType,
        contractNo: input.contractNo,
        route: "/previews",
        transferDirection: "in",
      },
    }),
  ];

  if (input.fromUser.email) {
    tasks.push(
      sendEmail(
        input.fromUser.email,
        `Preview reassigned: ${input.contractNo || input.reportId}`,
        transferEmailHtml({
          heading: "Preview ownership changed",
          message: `${adminName} reassigned this preview to ${toName}. It has been removed from your preview queue.`,
          contractNo: input.contractNo,
          reportType: input.reportType,
          previewUrl,
        })
      )
    );
  }
  if (input.toUser.email) {
    tasks.push(
      sendEmail(
        input.toUser.email,
        `Preview assigned to you: ${input.contractNo || input.reportId}`,
        transferEmailHtml({
          heading: "A preview was assigned to you",
          message: `${adminName} transferred this preview from ${fromName}. You can now open it, continue the work, and submit it.`,
          contractNo: input.contractNo,
          reportType: input.reportType,
          previewUrl,
        })
      )
    );
  }

  const results = await Promise.allSettled(tasks);
  return results
    .map((result, index) =>
      result.status === "rejected"
        ? `Transfer notification ${index + 1} failed: ${String(result.reason?.message || result.reason)}`
        : null
    )
    .filter((value): value is string => Boolean(value));
}
