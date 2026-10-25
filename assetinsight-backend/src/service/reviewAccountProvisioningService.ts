import mongoose from "mongoose";
import User from "../models/user.model.js";
import SecurityAuditEvent from "../models/securityAuditEvent.model.js";
import ReviewAccountBoundary from "../models/reviewAccountBoundary.model.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import PdfReport from "../models/pdfReport.model.js";
import RealEstateReport from "../models/realEstate.model.js";
import SalvageReport from "../models/salvage.model.js";
import ReportDraft from "../models/reportDraft.model.js";
import CrmLead from "../models/crmLead.model.js";
import CrmTaskTransfer from "../models/crmTaskTransfer.model.js";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";

export type ReviewAccountSetup = {
  userId: string;
  email: string;
  actorId: string;
  reason: string;
  apply?: boolean;
};

function state(user: any) {
  return {
    isReviewAccount: user.isReviewAccount === true,
    isCrmAgent: user.isCrmAgent === true,
    reportApprover: user.reportApprover ? String(user.reportApprover) : null,
    releaseManager: user.releaseManager ? String(user.releaseManager) : null,
  };
}

function assertEligible(user: any) {
  if (!user || user.role !== "user" || user.authProvider !== "email" || user.isBlocked
    || !user.isVerified || user.deviceApprovalMode !== "all_devices"
    || user.canManageSupport || user.proposalValuationEnabled || user.msOutlookCalendarConnected) {
    throw new Error("Use an active, already verified ordinary account with account-specific automatic device approval and no privileged/provider access.");
  }
}

async function assertEmptyAccount(id: mongoose.Types.ObjectId) {
  const checks = await Promise.all([
    ...[AssetReport, LotListing, PdfReport, RealEstateReport, SalvageReport].map((model: any) =>
      model.exists({ $or: [{ user: id }, { approval_assigned_to: id }, { release_assigned_to: id }] })),
    ReportDraft.exists({ user: id }),
    CrmLead.exists({ $or: [{ assignedTo: id }, { assignedBy: id }, { "updates.createdBy": id }] }),
    CrmTaskTransfer.exists({ $or: [{ fromUserId: id }, { toUserId: id }, { requestedBy: id }] }),
    AuctioneerWorkItem.exists({ $or: [{ claimedBy: id }, { assignmentUserId: String(id) }, { createdBy: id }] }),
    User.exists({ _id: { $ne: id }, $or: [{ reportApprover: id }, { releaseManager: id }] }),
  ]);
  if (checks.some(Boolean)) throw new Error("The account already owns data or has operational assignments; nothing was removed. Use a new empty reviewer account.");
}

/** No authentication bypass or public role-changing endpoint is introduced. */
export async function preparePlayReviewAccount(input: ReviewAccountSetup) {
  if (![input.userId, input.actorId].every((id) => /^[a-f\d]{24}$/i.test(id))) throw new Error("Exact user and actor IDs are required.");
  if (!input.email || input.email !== input.email.trim() || !input.reason?.trim() || input.reason.length > 1000) throw new Error("Exact email and a bounded audit reason are required.");
  const actor = await User.findOne({ _id: input.actorId, role: "superadmin", isBlocked: { $ne: true } }).select("_id").lean();
  if (!actor) throw new Error("The operator actor must be an active superadmin.");
  let user = await User.findOne({ _id: input.userId, email: input.email });
  assertEligible(user);
  if (!user) throw new Error("Reviewer identity does not match.");
  const desired = { isReviewAccount: true, isCrmAgent: true, reportApprover: user._id, releaseManager: user._id };
  const alreadyConfigured = user.isReviewAccount && user.isCrmAgent
    && String(user.reportApprover) === input.userId && String(user.releaseManager) === input.userId;
  if (alreadyConfigured) {
    await assertEnrollmentIntent(user);
    if (input.apply) {
      await ensureDurableBoundary(user);
      await recordCompletion(user, input);
    }
    return { status: "already_configured", userId: input.userId, state: state(user) };
  }
  if (user.isCrmAgent || user.reportApprover || user.releaseManager) throw new Error("Only an unassigned non-CRM account can be enrolled.");
  await assertEmptyAccount(user._id);
  if (!input.apply) return { status: "dry_run", userId: input.userId, state: state(desired) };

  // Establish the isolation boundary while CRM remains disabled. If a later
  // check/write fails the account stays isolated, not partly privileged.
  if (!user.isReviewAccount) {
    const intent = await SecurityAuditEvent.create({
      action: "review_account_setup_requested", actorType: "admin", actor: actor._id,
      targetUser: user._id, reason: input.reason, before: state(user), after: state(desired),
    });
    const guarded = await User.findOneAndUpdate({
      _id: user._id, email: input.email, updatedAt: user.updatedAt,
      isReviewAccount: { $ne: true }, isCrmAgent: { $ne: true },
    }, { $set: { isReviewAccount: true, reviewAccountSetupAudit: intent._id } }, { new: true });
    if (!guarded) throw new Error("Account changed during review enrollment; retry after inspection.");
    user = guarded;
  }
  await assertEnrollmentIntent(user);
  await ensureDurableBoundary(user);
  await assertEmptyAccount(user._id);
  const configured = await User.findOneAndUpdate({
    _id: user._id, email: input.email, updatedAt: user.updatedAt, role: "user",
    isReviewAccount: true, isCrmAgent: { $ne: true }, isBlocked: { $ne: true },
    isVerified: true, deviceApprovalMode: "all_devices", reportApprover: null, releaseManager: null,
    canManageSupport: { $ne: true }, proposalValuationEnabled: { $ne: true },
    msOutlookCalendarConnected: { $ne: true },
  }, { $set: { ...desired, crmAssignedAt: new Date(), crmAssignedBy: actor._id } }, { new: true });
  if (!configured) throw new Error("Account changed before the CRM grant; it remains isolated. Inspect and retry.");
  await recordCompletion(configured, input);
  return { status: "configured", userId: input.userId, state: state(configured) };
}

async function assertEnrollmentIntent(user: any) {
  if (!user.reviewAccountSetupAudit || !await SecurityAuditEvent.exists({
    _id: user.reviewAccountSetupAudit,
    action: "review_account_setup_requested",
    actorType: "admin",
    targetUser: user._id,
    "after.isReviewAccount": true,
  })) throw new Error("Reviewer setup has no matching audited enrollment receipt; no CRM grant made.");
}

async function ensureDurableBoundary(user: any) {
  await ReviewAccountBoundary.updateOne({ _id: user._id }, {
    $setOnInsert: { enrollmentAudit: user.reviewAccountSetupAudit },
  }, { upsert: true });
  if (!await ReviewAccountBoundary.exists({ _id: user._id, enrollmentAudit: user.reviewAccountSetupAudit })) {
    throw new Error("Reviewer isolation receipt does not match; no CRM grant made.");
  }
}

async function recordCompletion(user: any, input: ReviewAccountSetup) {
  const reason = `Enrollment ${String(user.reviewAccountSetupAudit)}: ${input.reason}`.slice(0, 1000);
  if (await SecurityAuditEvent.exists({ action: "review_account_setup_completed", targetUser: user._id, "after.enrollmentAudit": String(user.reviewAccountSetupAudit) })) return;
  await SecurityAuditEvent.create({ action: "review_account_setup_completed", actorType: "admin", actor: input.actorId,
    targetUser: user._id, reason, after: { ...state(user), enrollmentAudit: String(user.reviewAccountSetupAudit) } });
}
