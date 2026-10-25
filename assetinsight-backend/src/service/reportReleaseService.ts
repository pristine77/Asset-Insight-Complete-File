/**
 * Defines release ownership, file-readiness gates, download policy, and release side
 * effects for every report family. Approval and artifact checks happen before release
 * persistence; notification failures are isolated afterward because they must not roll
 * back an otherwise valid release decision.
 */
import mongoose, { Types } from "mongoose";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import PdfReport from "../models/pdfReport.model.js";
import RealEstateReport from "../models/realEstate.model.js";
import SalvageReport from "../models/salvage.model.js";
import User from "../models/user.model.js";
import { resolveIsolatedWorkflowAssignee } from "./reviewWorkflowAssignmentService.js";
import { notifyUser } from "./notificationService.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";
import {
  hasRequiredReportFiles,
  resolveReportGenerationStateForProfile,
  type ReportArtifactProfile,
  type ReportStatePayload,
} from "../utils/reportFileState.js";
import { refreshAuctioneerDeliveryReadinessForReport } from "./auctioneer2IntegrationService.js";

export type ReleaseStatus = "pending_release" | "released";
export type ReleaseAssignedSource =
  | "user_release_manager"
  | "manual_release_required"
  | "auto_released";
export type ReportApprovalState = "pending" | "approved" | "rejected";
export type ReportDownloadAccessCode =
  | "READY"
  | "AWAITING_APPROVAL"
  | "AWAITING_RELEASE"
  | "DECLINED"
  | "FILES_GENERATING"
  | "FILES_UNAVAILABLE";
export type ReportDownloadAccess = {
  allowed: boolean;
  code: ReportDownloadAccessCode;
  message: string;
  approval_status: ReportApprovalState;
  release_status: ReleaseStatus;
};

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

function plainId(value: unknown): string {
  const objectId = toObjectId(value);
  return objectId ? String(objectId) : "";
}

function getReportTitle(report: any, fallback = "Report"): string {
  return (
    report?.client_name ||
    report?.preview_data?.client_name ||
    report?.preview_data?.prepared_for ||
    report?.preview_data?.property_details?.address ||
    report?.property_details?.address ||
    report?.address ||
    report?.contract_no ||
    report?.filename ||
    fallback
  );
}

function getReportSummary(report: any): string {
  return (
    report?.contract_no ||
    report?.preview_data?.contract_no ||
    report?.preview_data?.location ||
    report?.fairMarketValue ||
    report?.property_details?.address ||
    ""
  );
}

export function normalizeReleaseManagerId(value: unknown): Types.ObjectId | null {
  return toObjectId(value);
}

export async function getReleaseManagerOptions() {
  return User.find({
    isBlocked: { $ne: true },
    isReviewAccount: { $ne: true },
  })
    .select("_id email username companyName role")
    .sort({ role: 1, username: 1, email: 1 })
    .lean();
}

export async function resolveReleaseManagerForUser(userId: unknown): Promise<Types.ObjectId | null> {
  const id = toObjectId(userId);
  if (!id) return null;
  return resolveIsolatedWorkflowAssignee(id, "releaseManager");
}

export async function assignReleaseManager(
  report: any,
  options: {
    userId?: unknown;
    releasedBy?: unknown;
    forceManual?: boolean;
  } = {}
): Promise<Types.ObjectId | null> {
  const userId = toObjectId(options.userId || report?.user);
  const managerId = await resolveReleaseManagerForUser(userId);
  const now = new Date();

  if (managerId) {
    setReleaseFields(report, {
      release_status: "pending_release",
      release_assigned_to: managerId,
      release_assigned_at: now,
      release_assigned_source: "user_release_manager",
      released_by: null,
      released_at: null,
    });
    return managerId;
  }

  if (options.forceManual) {
    setReleaseFields(report, {
      release_status: "pending_release",
      release_assigned_to: null,
      release_assigned_at: now,
      release_assigned_source: "manual_release_required",
      released_by: null,
      released_at: null,
    });
    return null;
  }

  setReleaseFields(report, {
    release_status: "released",
    release_assigned_to: null,
    release_assigned_at: null,
    release_assigned_source: "auto_released",
    released_by: options.releasedBy ? toObjectId(options.releasedBy) : null,
    released_at: now,
  });
  return null;
}

/**
 * These two families publish as part of approval. Asset and Lot Listing retain
 * their existing routing policies; only persisted, known report types opt in.
 */
export function approvalAutomaticallyReleases(reportType: unknown): boolean {
  return reportType === "RealEstate" || reportType === "Salvage";
}

/**
 * Complete a workflow without a separate release-manager decision.
 * Call only after approval/file-readiness checks and persist with the decision.
 * Clearing every assignment field prevents legacy manager settings from leaking
 * back into regenerated reports.
 */
export function markReportAutoReleased(
  report: any,
  options: { releasedBy?: unknown } = {}
) {
  setReleaseFields(report, {
    release_status: "released",
    release_assigned_to: null,
    release_assigned_at: null,
    release_assigned_source: "auto_released",
    release_assignment_email_sent_at: null,
    released_by: options.releasedBy ? toObjectId(options.releasedBy) : null,
    released_at: new Date(),
  });
}

function setReleaseFields(report: any, fields: Record<string, any>) {
  if (typeof report?.set === "function") {
    for (const [key, value] of Object.entries(fields)) {
      report.set(key, value);
    }
    return;
  }
  if (report) Object.assign(report, fields);
}

export function isReportReleased(report: any): boolean {
  const status = String(report?.release_status || "").trim();
  // Records created before release workflow existed were already downloadable. Treating
  // a missing field as released preserves that historical contract during migration.
  if (!status) return true;
  return status === "released";
}

export function releaseStatusForPayload(report: any): ReleaseStatus {
  return isReportReleased(report) ? "released" : "pending_release";
}

/**
 * Normalize approval state across new report models (`status`) and legacy
 * PdfReport rows (`approvalStatus`). Records created before approval workflow
 * fields existed remain approved for backwards compatibility.
 */
export function reportApprovalState(report: any): ReportApprovalState {
  const raw = String(report?.status || report?.approvalStatus || "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "approved" || raw === "completed") return "approved";
  if (raw === "rejected" || raw === "declined") return "rejected";
  return "pending";
}

export function getReportDownloadAccess(report: any): ReportDownloadAccess {
  // Approval and release are separate gates: approval validates content; release controls
  // publication. Returning reason codes keeps every API surface consistent.
  const approvalStatus = reportApprovalState(report);
  const releaseStatus = releaseStatusForPayload(report);

  if (approvalStatus === "rejected") {
    return {
      allowed: false,
      code: "DECLINED",
      message:
        "This report was not approved. Please resolve the approver feedback before downloading.",
      approval_status: approvalStatus,
      release_status: releaseStatus,
    };
  }

  if (approvalStatus !== "approved") {
    const assigned = Boolean(report?.approval_assigned_to);
    return {
      allowed: false,
      code: "AWAITING_APPROVAL",
      message: assigned
        ? "This report is waiting for approval from the assigned approver. Downloads will be available after approval."
        : "This report is waiting for approval. Downloads will be available after approval.",
      approval_status: approvalStatus,
      release_status: releaseStatus,
    };
  }

  if (releaseStatus !== "released") {
    return {
      allowed: false,
      code: "AWAITING_RELEASE",
      message:
        "This report is approved but is waiting to be released. Downloads will be available after release.",
      approval_status: approvalStatus,
      release_status: releaseStatus,
    };
  }

  return {
    allowed: true,
    code: "READY",
    message: "Report files are ready to download.",
    approval_status: approvalStatus,
    release_status: releaseStatus,
  };
}

export function getReportDownloadAccessForGeneration(
  report: any,
  generation: ReportStatePayload
): ReportDownloadAccess {
  const workflowAccess = getReportDownloadAccess(report);
  if (!workflowAccess.allowed) return workflowAccess;

  if (
    generation.generation_state === "queued" ||
    generation.generation_state === "processing"
  ) {
    return {
      ...workflowAccess,
      allowed: false,
      code: "FILES_GENERATING",
      message:
        "The latest report files are still being generated. Please refresh shortly.",
    };
  }

  if (
    generation.generation_state === "error" ||
    !generation.files_ready
  ) {
    return {
      ...workflowAccess,
      allowed: false,
      code: "FILES_UNAVAILABLE",
      message:
        generation.generation_state === "error"
          ? "The latest report file generation failed. Regenerate the report files or contact support."
          : "One or more required report files are unavailable. Regenerate the report files or contact support.",
    };
  }

  return workflowAccess;
}

export function getReportDownloadAccessForProfile(
  profile: ReportArtifactProfile,
  report: any,
  ...fileSources: any[]
): ReportDownloadAccess {
  return getReportDownloadAccessForGeneration(
    report,
    resolveReportGenerationStateForProfile(profile, report, ...fileSources)
  );
}

export function reportDownloadable(report: any): boolean {
  return getReportDownloadAccess(report).allowed;
}

function assertReportApprovedForRelease(report: any) {
  if (reportApprovalState(report) === "approved") return;
  const access = getReportDownloadAccess(report);
  throw Object.assign(new Error(access.message), {
    statusCode: 409,
    code: access.code,
    downloadAccess: access,
  });
}

function assertRequiredFilesForRelease(
  profile: ReportArtifactProfile,
  report: any
) {
  assertReportFilesReadyForWorkflow(profile, report);
}

export function assertReportFilesReadyForWorkflow(
  profile: ReportArtifactProfile,
  report: any
) {
  // Use the shared artifact profile rather than checking ad-hoc URLs. Required outputs
  // differ by report family and generation flags alone cannot prove upload completion.
  const generation = resolveReportGenerationStateForProfile(
    profile,
    report,
    report?.preview_files,
    report?.files
  );
  if (
    generation.generation_state === "queued" ||
    generation.generation_state === "processing"
  ) {
    throw Object.assign(
      new Error(
        "The latest report files are still being generated. Wait for generation to finish before approval or release."
      ),
      {
        statusCode: 409,
        code: "FILES_GENERATING",
      }
    );
  }
  if (generation.generation_state === "error") {
    throw Object.assign(
      new Error(
        "This report cannot be approved or released because the latest file generation failed. Regenerate the report files first."
      ),
      {
        statusCode: 409,
        code: "FILES_UNAVAILABLE",
      }
    );
  }
  if (
    !generation.files_ready ||
    !hasRequiredReportFiles(profile, report?.preview_files, report?.files)
  ) {
    throw Object.assign(
      new Error(
        "This report cannot be approved or released because one or more required files are unavailable. Regenerate the report files first."
      ),
      {
        statusCode: 409,
        code: "FILES_UNAVAILABLE",
      }
    );
  }
}

const SALVAGE_ARTIFACT_TYPES = ["pdf", "docx", "xlsx", "images"] as const;
const isSalvagePdf = (report: any): boolean => report?.reportModel === "SalvageReport" || report?.reportType === "Salvage";

export function pdfReportSiblingFilter(report: any): Record<string, any> {
  const parentId = toObjectId(report?.report);
  const filter: Record<string, any> = parentId ? { report: parentId } : { _id: report?._id };
  const ownerId = toObjectId(report?.user);
  if (parentId && ownerId) filter.user = ownerId;
  // Stale approval/release actions must never update a newer generation.
  if (report?.artifact_generation) filter.artifact_generation = report.artifact_generation;
  return filter;
}

export function isCurrentSalvagePdfArtifact(report: any, parent: any): boolean {
  if (!isSalvagePdf(report)) return true;
  if (!parent?.workflow_version) return !report?.artifact_generation;
  if (String(parent.user?._id || parent.user) !== String(report.user?._id || report.user)) return false;
  if (parent.files_stale || parent.files_generating || ["queued", "processing", "error", "failed"].includes(parent.job_status) || ["processing", "preview", "error"].includes(parent.status)) return false;
  if (!parent.artifact_generation || parent.artifact_generation !== report.artifact_generation) return false;
  if (!hasRequiredReportFiles("salvage", parent.files)) return false;
  if (!SALVAGE_ARTIFACT_TYPES.every((kind) => Boolean(parent.artifact_ids?.[kind]))) return false;
  if (new Set(Object.values(parent.artifact_ids || {}).map(String)).size !== 4) return false;
  const kind = String(report.fileType || "");
  return SALVAGE_ARTIFACT_TYPES.includes(kind as any) &&
    String(parent.artifact_ids[kind]) === String(report._id) &&
    parent.files[kind] === report.filePath;
}

export async function assertCurrentSalvagePdfArtifact(report: any): Promise<any | null> {
  if (!isSalvagePdf(report)) return null;
  const parentId = toObjectId(report.report);
  const parent = parentId ? await SalvageReport.findById(parentId).lean() : null;
  if (!isCurrentSalvagePdfArtifact(report, parent)) {
    throw Object.assign(new Error("This file generation is no longer current or is not complete. Refresh the report and wait for its current files."), { statusCode: 409, code: "FILES_UNAVAILABLE" });
  }
  return parent?.workflow_version ? parent : null;
}

export async function filterCurrentPdfReportArtifacts<T>(reports: T[]): Promise<T[]> {
  const salvage = reports.filter(isSalvagePdf);
  if (!salvage.length) return reports;
  const ids = salvage.map((row: any) => toObjectId(row.report)).filter(Boolean);
  const parents = await SalvageReport.find({ _id: { $in: ids } }).lean();
  const byId = new Map(parents.map((parent: any) => [String(parent._id), parent]));
  return reports.filter((row: any) => isCurrentSalvagePdfArtifact(row, byId.get(String(toObjectId(row.report)))));
}

/** Apply the publication gate before list pagination/counting, not after it. */
export function currentPdfArtifactAggregationStages(): Record<string, any>[] {
  const parent = "$__salvageParent";
  const stringValue = (value: string) => ({ $convert: { input: value, to: "string", onError: "", onNull: "" } });
  const hasValue = (value: string) => ({ $ne: [{ $trim: { input: stringValue(value) } }, ""] });
  const parentIdValues = SALVAGE_ARTIFACT_TYPES.map((kind) => stringValue(`${parent}.artifact_ids.${kind}`));
  const salvage = { $or: [{ $eq: ["$reportModel", "SalvageReport"] }, { $eq: ["$reportType", "Salvage"] }] };
  const canonical = { $gt: [{ $ifNull: [`${parent}.workflow_version`, 0] }, 0] };
  return [
    { $lookup: { from: SalvageReport.collection.name, localField: "report", foreignField: "_id", as: "__salvageParents" } },
    { $set: { __salvageParent: { $arrayElemAt: ["$__salvageParents", 0] } } },
    { $match: { $expr: { $or: [
      { $not: [salvage] },
      { $and: [{ $not: [canonical] }, { $eq: [{ $ifNull: ["$artifact_generation", ""] }, ""] }] },
      { $and: [
        canonical,
        { $eq: [`${parent}.user`, "$user"] },
        { $ne: [`${parent}.files_stale`, true] },
        { $ne: [`${parent}.files_generating`, true] },
        { $not: [{ $in: [`${parent}.job_status`, ["queued", "processing", "error", "failed"]] }] },
        { $not: [{ $in: [`${parent}.status`, ["processing", "preview", "error"]] }] },
        hasValue(`${parent}.artifact_generation`),
        { $eq: [`${parent}.artifact_generation`, "$artifact_generation"] },
        ...SALVAGE_ARTIFACT_TYPES.flatMap((kind) => [hasValue(`${parent}.files.${kind}`), hasValue(`${parent}.artifact_ids.${kind}`)]),
        { $eq: [{ $size: { $setUnion: [parentIdValues, []] } }, 4] },
        { $or: SALVAGE_ARTIFACT_TYPES.map((kind) => ({ $and: [
          { $eq: ["$fileType", kind] },
          { $eq: [stringValue(`${parent}.artifact_ids.${kind}`), stringValue("$_id")] },
          { $eq: [`${parent}.files.${kind}`, "$filePath"] },
        ] })) },
      ] },
    ] } } },
    { $unset: ["__salvageParents", "__salvageParent"] },
  ];
}

export async function assertLegacyPdfReportGroupFilesReady(report: any, requireDownloadAccess = false) {
  // Legacy salvage/real-estate outputs are sibling PdfReport documents. Read the entire
  // logical group before approval so a single present row cannot mask missing artifacts.
  const parent = await assertCurrentSalvagePdfArtifact(report);
  const filter = pdfReportSiblingFilter(report);

  const siblings = await PdfReport.find(filter)
    .select("filename fileType filePath imagesFolderPath user report reportModel reportType artifact_generation approvalStatus release_status")
    .lean();
  const availableTypes = new Set(
    siblings
      .filter((item: any) => {
        if (parent && !isCurrentSalvagePdfArtifact(item, parent)) return false;
        const path = String(item?.filePath || item?.imagesFolderPath || "").trim();
        return Boolean(path);
      })
      .map((item: any) => {
        const filename = String(item?.filename || "").trim().toLowerCase();
        const rawFileType =
          String(item?.fileType || "").trim().toLowerCase() ||
          filename.split(".").pop() ||
          "";
        return rawFileType === "zip" ||
          rawFileType === "images" ||
          filename.includes("images")
          ? "images"
          : rawFileType;
      })
  );
  const requiredTypes = parent ? [...SALVAGE_ARTIFACT_TYPES] : ["docx", "xlsx", "images"];
  const missingTypes = requiredTypes.filter((fileType) => !availableTypes.has(fileType));
  if (missingTypes.length === 0) {
    if (parent && requireDownloadAccess) {
      const denied = siblings.map(getReportDownloadAccess).find((access) => !access.allowed);
      if (denied) throw Object.assign(new Error(denied.message), { statusCode: 409, code: denied.code, downloadAccess: denied });
    }
    return;
  }

  throw Object.assign(
    new Error(
      `This report cannot be approved or released because required files are unavailable (${missingTypes.join(", ")}). Regenerate the report files first.`
    ),
    {
      statusCode: 409,
      code: "FILES_UNAVAILABLE",
    }
  );
}

export function canReleaseReport(report: any, user: any, isAdmin = false): boolean {
  if (isAdmin || user?.role === "admin" || user?.role === "superadmin") return true;
  const assignedId = plainId(report?.release_assigned_to);
  const userId = plainId(user?._id || user?.id);
  return Boolean(assignedId && userId && assignedId === userId);
}

export function releaseDeniedMessage(): string {
  return "This report is assigned to another release manager.";
}

export async function sendAssignedReleaseEmail(
  report: any,
  options: {
    reportType?: string;
    creatorUserId?: unknown;
    title?: string;
    summary?: string;
  } = {}
): Promise<boolean> {
  const managerId = toObjectId(report?.release_assigned_to);
  if (!managerId || report?.release_assignment_email_sent_at) return false;

  try {
    const [manager, creator] = await Promise.all([
      User.findById(managerId).select("email username companyName isBlocked isReviewAccount").lean(),
      options.creatorUserId || report?.user
        ? User.findById(toObjectId(options.creatorUserId || report?.user))
            .select("email username companyName isReviewAccount")
            .lean()
        : Promise.resolve(null),
    ]);

    if (!manager || (manager as any).isBlocked || !(manager as any).email) {
      return false;
    }
    if ((manager as any).isReviewAccount === true || (creator as any)?.isReviewAccount === true) return false;

    const reportType = options.reportType || report?.reportType || "Report";
    const title = options.title || getReportTitle(report, reportType);
    const creatorName =
      (creator as any)?.username ||
      (creator as any)?.companyName ||
      (creator as any)?.email ||
      "A user";
    const summary = options.summary || getReportSummary(report);
    const webUrl = (process.env.WEB_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
    const releaseUrl = `${webUrl}/releases`;
    const subject = `Release needed: ${reportType}`;
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;color:#111827;line-height:1.5;">
        <h2 style="margin:0 0 12px;">Report waiting for release</h2>
        <p>Hello ${escapeHtml((manager as any).username || (manager as any).email)},</p>
        <p>${escapeHtml(creatorName)} has an approved report waiting for release.</p>
        <ul>
          <li><strong>Type:</strong> ${escapeHtml(reportType)}</li>
          <li><strong>Report:</strong> ${escapeHtml(title)}</li>
          ${summary ? `<li><strong>Summary:</strong> ${escapeHtml(summary)}</li>` : ""}
          <li><strong>Created:</strong> ${escapeHtml(new Date(report?.createdAt || Date.now()).toLocaleString())}</li>
        </ul>
        <p>
          <a href="${releaseUrl}" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;">
            Open Assigned Releases
          </a>
        </p>
      </div>
    `;

    await sendEmail((manager as any).email, subject, html);
    // Set the marker only after transport acceptance. The caller saves the owning report
    // as part of its workflow, preventing a failed send from suppressing later retries.
    setReleaseFields(report, { release_assignment_email_sent_at: new Date() });
    return true;
  } catch (error) {
    console.error("Failed to send assigned release email", error);
    return false;
  }
}

export async function notifyReportReleased(report: any, reportType: string): Promise<void> {
  const userId = plainId(report?.user);
  if (!userId) return;
  const user = await User.findById(userId).select("email username").lean().catch(() => null);
  try {
    await notifyUser({
      userId,
      category: "report",
      type: "report_released",
      title: "Report Released",
      body: `Your ${reportType} report is released and ready to download.`,
      data: {
        type: "report_released",
        reportId: String(report?._id || ""),
        reportType,
      },
    });
  } catch (error) {
    console.error("Failed to send report release notification", error);
  }
  if ((user as any)?.email) {
    const webUrl = (process.env.WEB_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;color:#111827;line-height:1.5;">
        <h2 style="margin:0 0 12px;">Report released</h2>
        <p>Hello ${escapeHtml((user as any).username || (user as any).email)},</p>
        <p>Your ${escapeHtml(reportType)} report has been released. Downloads are now available in My Reports.</p>
        <p><a href="${webUrl}/reports" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;">Open My Reports</a></p>
      </div>
    `;
    await sendEmail((user as any).email, `${reportType} Released`, html).catch((error) => {
      console.error("Failed to send report released email", error);
    });
  }
}

export function releaseAssignedPopulatePath() {
  return {
    path: "release_assigned_to",
    select: "email username companyName role",
    model: mongoose.model("User"),
  };
}

export async function releaseReportGroupById(id: string, user: any, options: { isAdmin?: boolean } = {}) {
  // IDs historically refer to several collections, so resolve them in established order.
  // Persist release before best-effort delivery refresh/notifications: publication state
  // must not be rolled back because a secondary integration is temporarily unavailable.
  const releaserId = toObjectId(user?._id || user?.id);
  const now = new Date();

  const asset = await AssetReport.findOne({
    _id: id,
    is_draft_preview: { $ne: true },
  }).populate("user", "email username companyName");
  if (asset) {
    if (!canReleaseReport(asset, user, options.isAdmin)) {
      throw Object.assign(new Error(releaseDeniedMessage()), { statusCode: 403 });
    }
    assertReportApprovedForRelease(asset);
    assertRequiredFilesForRelease("asset", asset);
    setReleaseFields(asset, { release_status: "released", released_by: releaserId, released_at: now });
    await asset.save();
    await refreshAuctioneerDeliveryReadinessForReport(String(asset._id)).catch(
      () => undefined
    );
    await notifyReportReleased(asset, "Asset");
    return { reportType: "Asset", id: String(asset._id), released_at: now };
  }

  const realEstate = await RealEstateReport.findById(id).populate("user", "email username companyName");
  if (realEstate) {
    if (!canReleaseReport(realEstate, user, options.isAdmin)) {
      throw Object.assign(new Error(releaseDeniedMessage()), { statusCode: 403 });
    }
    assertReportApprovedForRelease(realEstate);
    assertRequiredFilesForRelease("realEstate", realEstate);
    setReleaseFields(realEstate, { release_status: "released", released_by: releaserId, released_at: now });
    await realEstate.save();
    await notifyReportReleased(realEstate, "Real Estate");
    return { reportType: "RealEstate", id: String(realEstate._id), released_at: now };
  }

  const lotListing = await LotListing.findOne({
    _id: id,
    is_draft_preview: { $ne: true },
  }).populate("user", "email username companyName");
  if (lotListing) {
    if (!canReleaseReport(lotListing, user, options.isAdmin)) {
      throw Object.assign(new Error(releaseDeniedMessage()), { statusCode: 403 });
    }
    assertReportApprovedForRelease(lotListing);
    assertRequiredFilesForRelease("lotListing", lotListing);
    setReleaseFields(lotListing, { release_status: "released", released_by: releaserId, released_at: now });
    await lotListing.save();
    await refreshAuctioneerDeliveryReadinessForReport(
      String(lotListing._id)
    ).catch(() => undefined);
    await notifyReportReleased(lotListing, "Lot Listing");
    return { reportType: "LotListing", id: String(lotListing._id), released_at: now };
  }

  const pdf = await PdfReport.findById(id).populate("user", "email username companyName");
  if (!pdf) return null;
  if (!canReleaseReport(pdf, user, options.isAdmin)) {
    throw Object.assign(new Error(releaseDeniedMessage()), { statusCode: 403 });
  }
  await assertCurrentSalvagePdfArtifact(pdf);
  const filter = pdfReportSiblingFilter(pdf);
  const siblings = await PdfReport.find(filter)
    .select("approvalStatus release_assigned_to")
    .lean();
  for (const sibling of siblings) {
    if (!canReleaseReport(sibling, user, options.isAdmin)) {
      throw Object.assign(new Error(releaseDeniedMessage()), { statusCode: 403 });
    }
    assertReportApprovedForRelease(sibling);
  }
  await assertLegacyPdfReportGroupFilesReady(pdf);

  // A legacy logical report has multiple artifact rows; release them together so access
  // does not vary by which sibling id the client uses.
  await PdfReport.updateMany(filter, {
    $set: {
      release_status: "released",
      released_by: releaserId,
      released_at: now,
    },
  });
  await notifyReportReleased(pdf, (pdf as any).reportType || "Report");
  return { reportType: (pdf as any).reportType || "Report", id: String((pdf as any).report || pdf._id), released_at: now };
}
