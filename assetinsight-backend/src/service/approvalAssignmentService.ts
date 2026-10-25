/**
 * Centralizes approval ownership, authorization scope, and assignment-email delivery.
 * A persisted sent marker provides best-effort duplicate suppression, but concurrent
 * callers are not atomically claimed. Assignment is snapshotted onto the report.
 */
import mongoose, { Types } from "mongoose";
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";
import { resolveIsolatedWorkflowAssignee } from "./reviewWorkflowAssignmentService.js";

export type ApprovalAssignedSource = "user_report_approver" | "unassigned";

function toObjectId(value: unknown): Types.ObjectId | null {
  if (!value) return null;
  if (value instanceof Types.ObjectId) return value;
  const raw =
    typeof value === "object" && value !== null && "_id" in value
      ? (value as any)._id
      : value;
  const id = String(raw || "").trim();
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getReportTitle(report: any, fallback = "Report"): string {
  return (
    report?.client_name ||
    report?.preview_data?.client_name ||
    report?.property_details?.address ||
    report?.preview_data?.property_details?.address ||
    report?.address ||
    report?.filename ||
    report?.contract_no ||
    fallback
  );
}

export function getUserIdFromReportUser(value: unknown): Types.ObjectId | null {
  return toObjectId(value);
}

export async function resolveReportApproverForUser(
  userId: unknown
): Promise<Types.ObjectId | null> {
  const id = toObjectId(userId);
  if (!id) return null;
  return resolveIsolatedWorkflowAssignee(id, "reportApprover");
}

export async function assignReportApprover(
  report: any,
  options: { userId?: unknown } = {}
): Promise<Types.ObjectId | null> {
  const userId = getUserIdFromReportUser(options.userId || report?.user);
  const approverId = await resolveReportApproverForUser(userId);
  const now = new Date();

  if (typeof report?.set === "function") {
    report.set("approval_assigned_to", approverId);
    report.set("approval_assigned_at", now);
    report.set(
      "approval_assigned_source",
      approverId ? "user_report_approver" : "unassigned"
    );
  } else if (report) {
    report.approval_assigned_to = approverId;
    report.approval_assigned_at = now;
    report.approval_assigned_source = approverId
      ? "user_report_approver"
      : "unassigned";
  }

  return approverId;
}

export async function sendAssignedApprovalEmail(
  report: any,
  options: {
    reportType?: string;
    creatorUserId?: unknown;
    title?: string;
    summary?: string;
  } = {}
): Promise<boolean> {
  const approverId = toObjectId(report?.approval_assigned_to);
  if (!approverId || report?.approval_assignment_email_sent_at) return false;

  const [approver, creator] = await Promise.all([
    User.findById(approverId).select("email username companyName isBlocked isReviewAccount").lean(),
    options.creatorUserId || report?.user
      ? User.findById(toObjectId(options.creatorUserId || report?.user)).select("email username companyName isReviewAccount").lean()
      : Promise.resolve(null),
  ]);

  if (!approver || (approver as any).isBlocked || !(approver as any).email) {
    return false;
  }
  if ((approver as any).isReviewAccount === true || (creator as any)?.isReviewAccount === true) return false;

  const reportType = options.reportType || report?.reportType || "Report";
  const title = options.title || getReportTitle(report, reportType);
  const creatorName =
    (creator as any)?.username ||
    (creator as any)?.companyName ||
    (creator as any)?.email ||
    "A user";
  const summary =
    options.summary ||
    report?.contract_no ||
    report?.preview_data?.contract_no ||
    report?.fairMarketValue ||
    "";
  const webUrl = (process.env.WEB_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const approvalUrl = `${webUrl}/approvals`;

  const subject = `Approval assigned: ${reportType}`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;color:#111827;line-height:1.5;">
      <h2 style="margin:0 0 12px;">Report ready for your approval</h2>
      <p>Hello ${escapeHtml((approver as any).username || (approver as any).email)},</p>
      <p>${escapeHtml(creatorName)} submitted a report assigned to you.</p>
      <ul>
        <li><strong>Type:</strong> ${escapeHtml(reportType)}</li>
        <li><strong>Report:</strong> ${escapeHtml(title)}</li>
        ${summary ? `<li><strong>Summary:</strong> ${escapeHtml(summary)}</li>` : ""}
        <li><strong>Created:</strong> ${escapeHtml(new Date(report?.createdAt || Date.now()).toLocaleString())}</li>
      </ul>
      <p>
        <a href="${approvalUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;">
          Open Assigned Approvals
        </a>
      </p>
    </div>
  `;

  try {
    await sendEmail((approver as any).email, subject, html);
  } catch (error) {
    console.error("Failed to send assigned approval email", error);
    return false;
  }

  if (typeof report?.set === "function") {
    report.set("approval_assignment_email_sent_at", new Date());
  } else if (report) {
    report.approval_assignment_email_sent_at = new Date();
  }
  return true;
}

export function approvalScopeFilter(adminUser: any): Record<string, any> {
  if (adminUser?.role === "superadmin") return {};
  const adminId = toObjectId(adminUser?._id || adminUser?.id);
  if (!adminId) {
    return {
      $or: [
        { approval_assigned_to: { $exists: false } },
        { approval_assigned_to: null },
      ],
    };
  }
  return {
    $or: [
      { approval_assigned_to: adminId },
      { approval_assigned_to: { $exists: false } },
      { approval_assigned_to: null },
    ],
  };
}

export function canProcessAssignedApproval(report: any, adminUser: any): boolean {
  if (adminUser?.role === "superadmin") return true;
  const assignedId = toObjectId(report?.approval_assigned_to);
  if (!assignedId) return true;
  const adminId = toObjectId(adminUser?._id || adminUser?.id);
  return Boolean(adminId && assignedId.equals(adminId));
}

export function assignedApprovalDeniedMessage(): string {
  return "This report is assigned to another manager for approval.";
}

export function normalizeReportApproverId(value: unknown): Types.ObjectId | null {
  return toObjectId(value);
}

export async function getReportApproverOptions() {
  return User.find({
    isBlocked: { $ne: true },
    isReviewAccount: { $ne: true },
  })
    .select("_id email username companyName role")
    .sort({ role: 1, username: 1, email: 1 })
    .lean();
}

export function mergeApprovalScope(base: Record<string, any>, adminUser: any) {
  const scope = approvalScopeFilter(adminUser);
  if (!Object.keys(scope).length) return base;
  return { $and: [base, scope] };
}

export function approvalAssignedPopulatePath() {
  return {
    path: "approval_assigned_to",
    select: "email username companyName role",
    model: mongoose.model("User"),
  };
}
