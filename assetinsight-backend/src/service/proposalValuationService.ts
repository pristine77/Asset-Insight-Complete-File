import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import PdfReport from "../models/pdfReport.model.js";
import User from "../models/user.model.js";
import {
  ASSET_SCHEDULE_CALCULATION_VERSION,
  buildAssetScheduleCalculations,
  buildDefaultAssetAdminScheduleSheet,
  calculateAssetAdminScheduleSheet,
  deriveAssetScheduleSummary,
  type AssetAdminScheduleEvaluatorColumn,
  type AssetAdminScheduleSheet,
} from "./assetAdminScheduleSheetService.js";
import { proposalValuationWritableRevisionCondition } from "./proposalValuationArtifactPublicationService.js";
import {
  broadcastProposalValuationRevision,
  disconnectProposalValuationUsers,
} from "./proposalValuationRealtimeService.js";
import type { ProposalValuationExcelData } from "./proposalValuationExcelService.js";

export const MAX_PROPOSAL_VALUATION_EVALUATORS = 4;
const MAX_RECENT_MUTATIONS = 50;
const MAX_CHANGES_PER_SAVE = 500;
const PARTICIPANT_SELECT =
  "_id username companyName email avatarUrl role isBlocked isVerified proposalValuationEnabled";

type ProposalValuationRole = "owner" | "evaluator";

type ProposalValuationAssignment = {
  user: any;
  column_id: string;
  added_by: any;
  added_at: Date;
};

export type ProposalValuationChange = {
  lotId?: string | null;
  field: string;
  value: unknown;
};

export class ProposalValuationError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ProposalValuationError";
  }
}

function plainId(value: unknown): string {
  if (!value) return "";
  if (typeof value === "object" && value !== null && "_id" in value) {
    return String((value as any)._id || "");
  }
  return String(value);
}

function safeString(value: unknown, maxLength = 500): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function displayName(user: any): string {
  return (
    safeString(user?.username, 160) ||
    safeString(user?.companyName, 200) ||
    safeString(user?.email, 320) ||
    "Evaluator"
  );
}

function currentRevision(report: any): number {
  const value = Number(report?.proposal_valuation_revision);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function currentAssignments(report: any): ProposalValuationAssignment[] {
  return Array.isArray(report?.proposal_valuation_evaluators)
    ? report.proposal_valuation_evaluators
    : [];
}

function assertArtifactPublicationIdle(report: any): void {
  const token = safeString(
    report?.proposal_valuation_artifact_publish_token,
    200
  );
  const expiresAt = report?.proposal_valuation_artifact_publish_expires_at
    ? new Date(report.proposal_valuation_artifact_publish_expires_at)
    : null;
  if (
    !token ||
    !expiresAt ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now()
  ) {
    return;
  }
  throw new ProposalValuationError(
    423,
    "PV_ARTIFACT_PUBLISH_IN_PROGRESS",
    "Proposal Valuation files are being published. Retry this save shortly.",
    {
      currentRevision: currentRevision(report),
      retryAfterMs: 750,
    }
  );
}

function proposalValuationEnabled(user: any): boolean {
  return Boolean(
    user &&
      user.role === "user" &&
      user.isVerified === true &&
      user.isBlocked !== true &&
      user.proposalValuationEnabled === true
  );
}

function assertProposalValuationEnabled(user: any): void {
  if (!proposalValuationEnabled(user)) {
    throw new ProposalValuationError(
      403,
      "PROPOSAL_VALUATION_DISABLED",
      "Proposal Valuation is not enabled for this account"
    );
  }
}

function assertEditableStatus(report: any): void {
  if (!["pending_approval", "approved"].includes(String(report?.status || ""))) {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_STATUS_INVALID",
      `Cannot update Proposal Valuation for status: ${report?.status || "unknown"}`
    );
  }
}

function accessRole(report: any, userId: string): ProposalValuationRole | null {
  if (plainId(report?.user) === userId) return "owner";
  return currentAssignments(report).some(
    (assignment) => plainId(assignment?.user) === userId
  )
    ? "evaluator"
    : null;
}

function revisionFilter(baseRevision: number): Record<string, unknown> {
  if (baseRevision === 0) {
    return {
      $or: [
        { proposal_valuation_revision: 0 },
        { proposal_valuation_revision: { $exists: false } },
        { proposal_valuation_revision: null },
      ],
    };
  }
  return { proposal_valuation_revision: baseRevision };
}

function cleanMutationId(value: unknown): string {
  const mutationId = safeString(value, 120);
  if (!mutationId || !/^[a-zA-Z0-9._:-]+$/.test(mutationId)) {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_MUTATION_ID_INVALID",
      "clientMutationId must be a stable identifier using letters, numbers, dot, underscore, colon, or dash"
    );
  }
  return mutationId;
}

function parseBaseRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_REVISION_INVALID",
      "baseRevision must be a non-negative integer"
    );
  }
  return revision;
}

function mutationAlreadyApplied(
  report: any,
  userId: string,
  mutationId: string,
  kind?: "draft" | "evaluators" | "regenerate" | "admin"
) {
  const mutations = Array.isArray(report?.proposal_valuation_recent_mutations)
    ? report.proposal_valuation_recent_mutations
    : [];
  return mutations.some(
    (mutation: any) =>
      safeString(mutation?.id, 120) === mutationId &&
      plainId(mutation?.user) === userId &&
      (!kind || mutation?.kind === kind)
  );
}

function matchingMutation(
  report: any,
  userId: string,
  mutationId: string,
  kind: "draft" | "evaluators" | "regenerate" | "admin"
) {
  const mutations = Array.isArray(report?.proposal_valuation_recent_mutations)
    ? report.proposal_valuation_recent_mutations
    : [];
  return mutations.find(
    (mutation: any) =>
      safeString(mutation?.id, 120) === mutationId &&
      plainId(mutation?.user) === userId &&
      mutation?.kind === kind
  );
}

function regenerationIsDurablyRequested(report: any): boolean {
  return Boolean(
    report?.files_generating ||
      report?.files_regenerating ||
      report?.files_regeneration_pending ||
      ["queued", "processing"].includes(String(report?.job_status || ""))
  );
}

function regenerationClaimInProgress(report: any): never {
  throw new ProposalValuationError(
    409,
    "PV_REGENERATION_CLAIM_IN_PROGRESS",
    "Proposal Valuation regeneration is being queued. Retry shortly.",
    {
      currentRevision: currentRevision(report),
      retryAfterMs: 500,
    }
  );
}

function linkedColumnId(userId: string): string {
  return `pv_${userId}`;
}

function assignmentUser(assignment: { user: any }): any {
  const value = assignment?.user;
  if (!value || typeof value !== "object") return null;
  // A Mongoose ObjectId is also an object (and exposes an `_id` getter), but it
  // is not populated participant data. Requiring a safe participant field keeps
  // generic/admin preview reads from replacing stored linked metadata with the
  // fallback label when a query forgot to populate.
  if (
    !["username", "companyName", "email", "avatarUrl"].some((field) =>
      Object.prototype.hasOwnProperty.call(value, field)
    )
  ) {
    return null;
  }
  return value;
}

function reconcileLinkedEvaluatorColumns(
  sheet: AssetAdminScheduleSheet,
  assignments: ProposalValuationAssignment[],
  owner: any
): AssetAdminScheduleSheet {
  const ownerId = plainId(owner);
  const legacyColumns = sheet.evaluator_columns.filter(
    (column) => !safeString(column.user_id, 64)
  );
  const existingLinked = new Map(
    sheet.evaluator_columns
      .filter((column) => safeString(column.user_id, 64))
      .map((column) => [safeString(column.user_id, 64), column])
  );
  const usedColumnIds = new Set(legacyColumns.map((column) => column.id));
  const allStoredColumnIds = new Set(sheet.evaluator_columns.map(column => column.id));
  let ownerColumnId = existingLinked.get(ownerId)?.id || linkedColumnId(ownerId);
  // A historical text-only column is not an owner identity match. Never adopt
  // its values merely because its id happens to use the new default pattern.
  if (ownerId && !existingLinked.has(ownerId)) {
    for (let suffix = 1; allStoredColumnIds.has(ownerColumnId); suffix += 1) {
      ownerColumnId = `${linkedColumnId(ownerId)}_owner_${suffix}`;
    }
  }
  const columnAssignments = [
    ...(ownerId ? [{ user: owner, column_id: ownerColumnId }] : []),
    ...assignments.filter(assignment => plainId(assignment.user) !== ownerId),
  ];

  const linkedColumns: AssetAdminScheduleEvaluatorColumn[] = columnAssignments.map(
    (assignment) => {
      const userId = plainId(assignment.user);
      const user = assignmentUser(assignment);
      const existing = existingLinked.get(userId);
      let id = safeString(assignment.column_id, 120) || existing?.id || linkedColumnId(userId);
      if (usedColumnIds.has(id)) id = linkedColumnId(userId);
      usedColumnIds.add(id);
      return {
        id,
        name: user ? displayName(user) : existing?.name || (userId === ownerId ? "Report owner" : "Evaluator"),
        user_id: userId,
        email: user
          ? safeString(user?.email, 320)
          : safeString(existing?.email, 320),
        ...(safeString(user?.avatarUrl || existing?.avatar_url, 2_000)
          ? {
              avatar_url: safeString(
                user?.avatarUrl || existing?.avatar_url,
                2_000
              ),
            }
          : {}),
      };
    }
  );

  return calculateAssetAdminScheduleSheet({
    ...sheet,
    evaluator_columns: [...legacyColumns, ...linkedColumns],
  });
}

function reportSheet(report: any): AssetAdminScheduleSheet {
  const stored = report?.preview_data?.admin_schedule_sheet;
  const calculated = calculateAssetAdminScheduleSheet(
    stored ?? buildDefaultAssetAdminScheduleSheet(report),
    report
  );
  return reconcileLinkedEvaluatorColumns(calculated, currentAssignments(report), report?.user);
}

export function getCanonicalProposalValuationSheet(report: any) {
  return reportSheet(report);
}

function participantDto(user: any, input: { columnId?: string | null; isOwner: boolean }) {
  return {
    id: plainId(user),
    username: safeString(user?.username, 160),
    companyName: safeString(user?.companyName, 200),
    email: safeString(user?.email, 320),
    avatarUrl: safeString(user?.avatarUrl, 2_000),
    columnId: input.columnId || null,
    isOwner: input.isOwner,
  };
}

function reportTitle(report: any): string {
  const previewData = report?.preview_data || {};
  const contractNo = safeString(previewData.contract_no || report?.contract_no, 200);
  if (contractNo) return `Asset - ${contractNo}`;
  return (
    safeString(
      previewData.client_name ||
        previewData.prepared_for ||
        report?.client_name ||
        report?.prepared_for,
      300
    ) || "Asset Report"
  );
}

function reportMeta(report: any) {
  const previewData = report?.preview_data || {};
  return [
    { label: "Report Type", value: "Asset" },
    { label: "Status", value: safeString(report?.status, 80) },
    {
      label: "Contract",
      value: safeString(previewData.contract_no || report?.contract_no, 200),
    },
    {
      label: "Client",
      value: safeString(previewData.client_name || report?.client_name, 300),
    },
    {
      label: "Prepared For",
      value: safeString(previewData.prepared_for || report?.prepared_for, 300),
    },
  ].filter((item) => item.value);
}

function buildProposalValuationExcelData(
  report: any
): ProposalValuationExcelData {
  const assetScheduleSheet = reportSheet(report);
  const summary = deriveAssetScheduleSummary(assetScheduleSheet);
  return {
    reportId: plainId(report?._id),
    title: reportTitle(report),
    meta: reportMeta(report),
    currencyCode: safeString(
      report?.preview_data?.currency || report?.currency || "CAD",
      12
    ).toUpperCase(),
    assetScheduleSheet,
    revision: currentRevision(report),
    summary,
    calculationVersion: ASSET_SCHEDULE_CALCULATION_VERSION,
    calculations: buildAssetScheduleCalculations(assetScheduleSheet, summary),
  };
}

async function resolveAssetReportId(reportId: string): Promise<string | null> {
  if (!mongoose.Types.ObjectId.isValid(reportId)) return null;
  const direct = await AssetReport.exists({
    _id: reportId,
    is_draft_preview: { $ne: true },
  });
  if (direct) return reportId;
  const pdfReport = await PdfReport.findById(reportId)
    .select("report reportModel")
    .lean();
  if (
    !pdfReport ||
    String((pdfReport as any).reportModel || "") !== "AssetReport" ||
    !(pdfReport as any).report
  ) {
    return null;
  }
  return plainId((pdfReport as any).report);
}

async function populatedReport(reportId: string): Promise<any | null> {
  const assetReportId = await resolveAssetReportId(reportId);
  if (!assetReportId) return null;
  return AssetReport.findOne({
    _id: assetReportId,
    is_draft_preview: { $ne: true },
  })
    .populate({ path: "user", select: PARTICIPANT_SELECT, transform: (user, id) => user || id })
    .populate("proposal_valuation_evaluators.user", PARTICIPANT_SELECT)
    .lean();
}

export function buildProposalValuationWorkspace(
  report: any,
  viewerId: string,
  role = accessRole(report, viewerId),
  options: { idempotent?: boolean } = {}
) {
  if (!role) {
    throw new ProposalValuationError(
      404,
      "PROPOSAL_VALUATION_NOT_FOUND",
      "Asset report not found"
    );
  }
  const exportData = buildProposalValuationExcelData(report);
  const assignments = currentAssignments(report);
  const ownAssignment = assignments.find(
    (assignment) => plainId(assignment.user) === viewerId
  );
  const owner = report?.user;
  const participants = [
    participantDto(owner, { isOwner: true, columnId: exportData.assetScheduleSheet.evaluator_columns.find(column => column.user_id === plainId(owner))?.id || null }),
    ...assignments.filter(assignment => plainId(assignment.user) !== plainId(owner)).map((assignment) =>
      participantDto(assignmentUser(assignment), {
        isOwner: false,
        columnId: safeString(assignment.column_id, 120),
      })
    ),
  ].filter((participant) => participant.id);

  return {
    reportId: exportData.reportId,
    title: exportData.title,
    meta: exportData.meta,
    variant: "assetScheduleSheet" as const,
    currencyCode: exportData.currencyCode,
    assetScheduleSheet: exportData.assetScheduleSheet,
    ownerColumnId: exportData.assetScheduleSheet.evaluator_columns.find(column => column.user_id === plainId(owner))?.id || null,
    revision: exportData.revision,
    permissions: {
      canManageEvaluators: role === "owner",
      canEditAll: role === "owner",
      evaluatorColumnId:
        role === "evaluator" ? safeString(ownAssignment?.column_id, 120) || null : null,
      canRegenerateFiles: role === "owner",
    },
    participants,
    summary: exportData.summary,
    calculationVersion: exportData.calculationVersion,
    calculations: exportData.calculations,
    ...(options.idempotent ? { idempotent: true } : {}),
  };
}

export async function getProposalValuationWorkspace(
  reportId: string,
  user: any
) {
  assertProposalValuationEnabled(user);
  const report = await populatedReport(reportId);
  const viewerId = plainId(user);
  const role = report ? accessRole(report, viewerId) : null;
  if (!report || !role) {
    throw new ProposalValuationError(
      404,
      "PROPOSAL_VALUATION_NOT_FOUND",
      "Asset report not found"
    );
  }
  return buildProposalValuationWorkspace(report, viewerId, role);
}

/**
 * Uses the same feature, ownership, and assignment checks as the interactive
 * user workspace before exposing a workbook snapshot.
 */
export async function getProposalValuationExcelData(
  reportId: string,
  user: any
): Promise<ProposalValuationExcelData> {
  const workspace = await getProposalValuationWorkspace(reportId, user);
  return {
    reportId: workspace.reportId,
    title: workspace.title,
    meta: workspace.meta,
    currencyCode: workspace.currencyCode,
    assetScheduleSheet: workspace.assetScheduleSheet,
    revision: workspace.revision,
    summary: workspace.summary,
    calculationVersion: workspace.calculationVersion,
    calculations: workspace.calculations,
  };
}

/**
 * Admin HTTP authorization is deliberately owned by adminProtect plus
 * requireAccessibleAdminReport. This loader only resolves the Asset/PdfReport
 * identity and builds the same canonical workbook snapshot used for users.
 */
export async function getAdminProposalValuationExcelData(
  reportId: string
): Promise<ProposalValuationExcelData> {
  const report = await populatedReport(reportId);
  if (!report) {
    throw new ProposalValuationError(
      404,
      "PROPOSAL_VALUATION_NOT_FOUND",
      "Asset report not found"
    );
  }
  return buildProposalValuationExcelData(report);
}

export async function listProposalValuations(user: any) {
  assertProposalValuationEnabled(user);
  const userId = plainId(user);
  const reports = await AssetReport.find({
    status: { $in: ["pending_approval", "approved"] },
    is_draft_preview: { $ne: true },
    $or: [
      { user: userId as any },
      { "proposal_valuation_evaluators.user": userId as any },
    ],
  })
    .select(
      "user status contract_no client_name prepared_for currency preview_data.contract_no preview_data.client_name preview_data.prepared_for preview_data.currency proposal_valuation_revision proposal_valuation_evaluators updatedAt"
    )
    .sort({ updatedAt: -1, _id: -1 })
    .limit(250)
    .lean();

  return {
    items: reports.map((report: any) => ({
      reportId: plainId(report._id),
      title: reportTitle(report),
      contractNo: safeString(
        report?.preview_data?.contract_no || report?.contract_no,
        200
      ),
      status: safeString(report.status, 80),
      role: plainId(report.user) === userId ? "owner" : "evaluator",
      updatedAt: report.updatedAt,
      revision: currentRevision(report),
      participantCount: 1 + currentAssignments(report).length,
      currencyCode: safeString(
        report?.preview_data?.currency || report?.currency || "CAD",
        12
      ).toUpperCase(),
    })),
  };
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listProposalValuationEvaluatorOptions(input: {
  reportId: string;
  requesterId?: string;
  requester?: any;
  q?: unknown;
  admin?: boolean;
}) {
  if (!input.admin) assertProposalValuationEnabled(input.requester);
  const assetReportId = await resolveAssetReportId(input.reportId);
  const report = assetReportId
    ? await AssetReport.findOne({
        _id: assetReportId,
        is_draft_preview: { $ne: true },
      }).select("user").lean()
    : null;
  if (!report) {
    throw new ProposalValuationError(
      404,
      "PROPOSAL_VALUATION_NOT_FOUND",
      "Asset report not found"
    );
  }
  if (!input.admin && plainId(report.user) !== safeString(input.requesterId, 64)) {
    throw new ProposalValuationError(
      404,
      "PROPOSAL_VALUATION_NOT_FOUND",
      "Asset report not found"
    );
  }

  const q = safeString(input.q, 120);
  const filter: Record<string, any> = {
    _id: { $ne: report.user },
    role: "user",
    isBlocked: { $ne: true },
    isVerified: true,
    proposalValuationEnabled: true,
  };
  if (q) {
    const regex = new RegExp(escapeRegex(q), "i");
    filter.$or = [
      { username: regex },
      { companyName: regex },
      { email: regex },
    ];
  }

  const users = await User.find(filter)
    .select("_id username companyName email avatarUrl")
    .sort({ username: 1, companyName: 1, email: 1 })
    .limit(50)
    .lean();

  return {
    items: users.map((candidate: any) => ({
      id: plainId(candidate._id),
      username: safeString(candidate.username, 160),
      companyName: safeString(candidate.companyName, 200),
      email: safeString(candidate.email, 320),
      avatarUrl: safeString(candidate.avatarUrl, 2_000),
    })),
  };
}

async function eligibleEvaluatorUsers(userIds: string[]) {
  const ids = userIds.map((id) => new mongoose.Types.ObjectId(id));
  const users = await User.find({
    _id: { $in: ids },
    role: "user",
    isBlocked: { $ne: true },
    isVerified: true,
    proposalValuationEnabled: true,
  })
    .select(PARTICIPANT_SELECT)
    .lean();
  const byId = new Map(users.map((user: any) => [plainId(user._id), user]));
  if (byId.size !== userIds.length) {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_EVALUATOR_INVALID",
      "One or more selected evaluators are unavailable or not enabled for Proposal Valuation"
    );
  }
  return byId;
}

function validateEvaluatorIds(rawUserIds: unknown, ownerId: string): string[] {
  if (!Array.isArray(rawUserIds)) {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_EVALUATORS_REQUIRED",
      "evaluatorUserIds must be an array"
    );
  }
  const userIds = rawUserIds.map((value) => safeString(value, 64));
  if (userIds.length > MAX_PROPOSAL_VALUATION_EVALUATORS) {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_EVALUATOR_LIMIT",
      `A Proposal Valuation can have at most ${MAX_PROPOSAL_VALUATION_EVALUATORS} additional evaluators`
    );
  }
  if (new Set(userIds).size !== userIds.length) {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_EVALUATOR_DUPLICATE",
      "Each evaluator can be selected only once"
    );
  }
  if (
    userIds.some(
      (id) => !mongoose.Types.ObjectId.isValid(id) || id === ownerId
    )
  ) {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_EVALUATOR_INVALID",
      "The owner cannot be selected as an additional evaluator"
    );
  }
  return userIds;
}

function mutationPush(
  userId: string,
  mutationId: string,
  revision: number,
  kind: "draft" | "evaluators" | "regenerate" | "admin"
) {
  return {
    $each: [
      {
        id: mutationId,
        user: new mongoose.Types.ObjectId(userId),
        kind,
        revision,
        created_at: new Date(),
      },
    ],
    $slice: -MAX_RECENT_MUTATIONS,
  };
}

async function conflictOrIdempotent(
  reportId: string,
  userId: string,
  mutationId: string,
  kind: "draft" | "evaluators"
) {
  const latest = await populatedReport(reportId);
  if (
    latest &&
    mutationAlreadyApplied(latest, userId, mutationId, kind) &&
    accessRole(latest, userId)
  ) {
    return buildProposalValuationWorkspace(latest, userId, undefined, {
      idempotent: true,
    });
  }
  assertArtifactPublicationIdle(latest);
  throw new ProposalValuationError(
    409,
    "PV_REVISION_CONFLICT",
    "Proposal Valuation changed in another session. Reload the latest revision and try again.",
    { currentRevision: currentRevision(latest) }
  );
}

export async function replaceProposalValuationEvaluators(input: {
  reportId: string;
  owner: any;
  evaluatorUserIds: unknown;
  baseRevision: unknown;
  clientMutationId: unknown;
}) {
  assertProposalValuationEnabled(input.owner);
  const ownerId = plainId(input.owner);
  const baseRevision = parseBaseRevision(input.baseRevision);
  const mutationId = cleanMutationId(input.clientMutationId);
  const report = await populatedReport(input.reportId);
  if (!report || plainId(report.user) !== ownerId) {
    throw new ProposalValuationError(
      404,
      "PROPOSAL_VALUATION_NOT_FOUND",
      "Asset report not found"
    );
  }
  assertEditableStatus(report);
  if (mutationAlreadyApplied(report, ownerId, mutationId, "evaluators")) {
    return buildProposalValuationWorkspace(report, ownerId, "owner", {
      idempotent: true,
    });
  }
  if (currentRevision(report) !== baseRevision) {
    return conflictOrIdempotent(
      input.reportId,
      ownerId,
      mutationId,
      "evaluators"
    );
  }
  assertArtifactPublicationIdle(report);

  const evaluatorUserIds = validateEvaluatorIds(
    input.evaluatorUserIds,
    ownerId
  );
  const usersById = await eligibleEvaluatorUsers(evaluatorUserIds);
  const existingByUser = new Map(
    currentAssignments(report).map((assignment) => [
      plainId(assignment.user),
      assignment,
    ])
  );
  const now = new Date();
  const assignments = evaluatorUserIds.map((userId) => {
    const existing = existingByUser.get(userId);
    return {
      user: usersById.get(userId),
      column_id:
        safeString(existing?.column_id, 120) || linkedColumnId(userId),
      added_by: existing?.added_by || new mongoose.Types.ObjectId(ownerId),
      added_at: existing?.added_at || now,
    };
  });
  const nextSheet = reconcileLinkedEvaluatorColumns(reportSheet(report), assignments, report.user);
  const nextRevision = baseRevision + 1;
  const storedAssignments = assignments.map((assignment) => ({
    user: new mongoose.Types.ObjectId(plainId(assignment.user)),
    column_id: assignment.column_id,
    added_by: assignment.added_by,
    added_at: assignment.added_at,
  }));
  const set: Record<string, unknown> = {
    proposal_valuation_evaluators: storedAssignments,
    "preview_data.admin_schedule_sheet": nextSheet,
    proposal_valuation_updated_by: new mongoose.Types.ObjectId(ownerId),
    proposal_valuation_updated_at: now,
  };
  if (
    report.files_generating ||
    report.files_regenerating ||
    report.excel_regenerating ||
    ["queued", "processing"].includes(String(report.job_status || ""))
  ) {
    set.files_regeneration_pending = true;
  }

  const saved = await AssetReport.findOneAndUpdate(
    {
      _id: report._id,
      status: { $in: ["pending_approval", "approved"] },
      is_draft_preview: { $ne: true },
      ...proposalValuationWritableRevisionCondition(baseRevision),
    },
    {
      $set: set,
      $inc: { proposal_valuation_revision: 1 },
      $push: {
        proposal_valuation_recent_mutations: mutationPush(
          ownerId,
          mutationId,
          nextRevision,
          "evaluators"
        ),
      },
    },
    { new: true }
  );
  if (!saved) {
    return conflictOrIdempotent(
      input.reportId,
      ownerId,
      mutationId,
      "evaluators"
    );
  }
  // Assignment revocation is a post-commit security effect. Perform it before
  // the fallible population read used to build the response so a transient DB
  // read cannot leave removed evaluators on an already-open stream.
  disconnectProposalValuationUsers(
    input.reportId,
    new Set([ownerId, ...evaluatorUserIds])
  );
  broadcastProposalValuationRevision({
    reportId: input.reportId,
    revision: nextRevision,
    updatedAt: now,
    updatedBy: ownerId,
    mutationId,
  });
  const populated = await populatedReport(input.reportId);
  return buildProposalValuationWorkspace(populated, ownerId, "owner");
}

export async function saveAdminProposalValuationSheet(input: {
  reportId: string;
  adminUserId: string;
  rawSheet: unknown;
  baseRevision?: unknown;
}) {
  const report = await populatedReport(input.reportId);
  if (!report) {
    throw new ProposalValuationError(
      404,
      "PROPOSAL_VALUATION_NOT_FOUND",
      "Asset report not found"
    );
  }
  assertEditableStatus(report);
  const revision =
    input.baseRevision === undefined || input.baseRevision === null
      ? currentRevision(report)
      : parseBaseRevision(input.baseRevision);
  if (currentRevision(report) !== revision) {
    throw new ProposalValuationError(
      409,
      "PV_REVISION_CONFLICT",
      "Proposal Valuation changed in another session. Reload the latest revision and try again.",
      { currentRevision: currentRevision(report) }
    );
  }
  assertArtifactPublicationIdle(report);
  if (!input.rawSheet || typeof input.rawSheet !== "object") {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_SHEET_REQUIRED",
      "assetScheduleSheet is required"
    );
  }

  let submittedSheet = calculateAssetAdminScheduleSheet(input.rawSheet, report);
  const ownerId = plainId(report.user);
  const existingSheet = reportSheet(report);
  const ownerColumn = existingSheet.evaluator_columns.find(column => column.user_id === ownerId);
  const submittedOwnerColumns = submittedSheet.evaluator_columns.filter(column => column.user_id === ownerId);
  if (ownerColumn && (submittedOwnerColumns.length > 1 ||
      submittedOwnerColumns.some(column => column.id !== ownerColumn.id) ||
      submittedSheet.evaluator_columns.some(column => column.id === ownerColumn.id && column.user_id !== ownerId))) {
    throw new ProposalValuationError(400, "PROPOSAL_VALUATION_OWNER_COLUMN_INVALID", "The report owner's evaluator column identity cannot be changed");
  }
  if (ownerColumn && submittedOwnerColumns.length === 0) {
    const previousRows = new Map(existingSheet.rows.map(row => [row.lot_id, row]));
    submittedSheet = calculateAssetAdminScheduleSheet({
      ...submittedSheet,
      evaluator_columns: [...submittedSheet.evaluator_columns, ownerColumn],
      rows: submittedSheet.rows.map(row => ({ ...row, evaluator_values: {
        ...row.evaluator_values,
        [ownerColumn.id]: previousRows.get(row.lot_id)?.evaluator_values[ownerColumn.id] ?? null,
      } })),
    });
  }
  const linkedColumns = submittedSheet.evaluator_columns.filter((column) =>
    Boolean(safeString(column.user_id, 64)) && column.user_id !== ownerId
  );
  const evaluatorUserIds = validateEvaluatorIds(
    linkedColumns.map((column) => column.user_id),
    plainId(report.user)
  );
  const usersById = await eligibleEvaluatorUsers(evaluatorUserIds);
  const existingByUser = new Map(
    currentAssignments(report).map((assignment) => [
      plainId(assignment.user),
      assignment,
    ])
  );
  const submittedColumnByUser = new Map(
    linkedColumns.map((column) => [safeString(column.user_id, 64), column])
  );
  const now = new Date();
  const assignments = evaluatorUserIds.map((userId) => {
    const existing = existingByUser.get(userId);
    const submittedColumnId = safeString(
      submittedColumnByUser.get(userId)?.id,
      120
    );
    return {
      user: usersById.get(userId),
      column_id:
        safeString(existing?.column_id, 120) ||
        (/^[a-zA-Z0-9._:-]+$/.test(submittedColumnId)
          ? submittedColumnId
          : linkedColumnId(userId)),
      added_by:
        existing?.added_by || new mongoose.Types.ObjectId(input.adminUserId),
      added_at: existing?.added_at || now,
    };
  });
  const nextSheet = reconcileLinkedEvaluatorColumns(
    submittedSheet,
    assignments,
    report.user
  );
  const storedAssignments = assignments.map((assignment) => ({
    user: new mongoose.Types.ObjectId(plainId(assignment.user)),
    column_id: assignment.column_id,
    added_by: assignment.added_by,
    added_at: assignment.added_at,
  }));
  const set: Record<string, unknown> = {
    proposal_valuation_evaluators: storedAssignments,
    "preview_data.admin_schedule_sheet": nextSheet,
    proposal_valuation_updated_by: new mongoose.Types.ObjectId(input.adminUserId),
    proposal_valuation_updated_at: now,
  };
  if (
    report.files_generating ||
    report.files_regenerating ||
    report.excel_regenerating ||
    ["queued", "processing"].includes(String(report.job_status || ""))
  ) {
    set.files_regeneration_pending = true;
  }
  const saved = await AssetReport.findOneAndUpdate(
    {
      _id: report._id,
      status: { $in: ["pending_approval", "approved"] },
      is_draft_preview: { $ne: true },
      ...proposalValuationWritableRevisionCondition(revision),
    },
    {
      $set: set,
      $inc: { proposal_valuation_revision: 1 },
    },
    { new: true }
  );
  if (!saved) {
    const latest = await populatedReport(input.reportId);
    assertArtifactPublicationIdle(latest);
    throw new ProposalValuationError(
      409,
      "PV_REVISION_CONFLICT",
      "Proposal Valuation changed in another session. Reload the latest revision and try again.",
      { currentRevision: currentRevision(latest) }
    );
  }
  const nextRevision = revision + 1;
  disconnectProposalValuationUsers(
    input.reportId,
    new Set([ownerId, ...evaluatorUserIds].filter(Boolean))
  );
  broadcastProposalValuationRevision({
    reportId: input.reportId,
    revision: nextRevision,
    updatedAt: now,
    updatedBy: input.adminUserId,
  });
  const populated = await populatedReport(plainId(saved._id));
  const sheet = reportSheet(populated);
  const summary = deriveAssetScheduleSummary(sheet);
  return {
    reportId: plainId(saved._id),
    assetScheduleSheet: sheet,
    ownerColumnId: sheet.evaluator_columns.find(column => column.user_id === plainId(populated?.user))?.id || null,
    revision: currentRevision(populated),
    summary,
    calculationVersion: ASSET_SCHEDULE_CALCULATION_VERSION,
    calculations: buildAssetScheduleCalculations(sheet, summary),
    participantUserIds: [
      plainId(populated?.user),
      ...currentAssignments(populated).map((assignment) =>
        plainId(assignment.user)
      ),
    ].filter(Boolean),
  };
}

const OWNER_TEXT_ROW_FIELDS = new Map<string, number>([
  ["asset_category", 300],
  ["year", 40],
  ["make", 200],
  ["model", 240],
  ["serial_number", 240],
  ["cr_details", 12_000],
  ["condition_score", 80],
  ["location", 500],
  ["notes", 8_000],
]);
const OWNER_NUMBER_ROW_FIELDS = new Set(["lien_search", "video_cost"]);
const MARKET_CHECK_OPTIONS: Record<string, Set<string>> = {
  "market_check.comparable_count": new Set(["", "High", "Moderate", "Low"]),
  "market_check.avg_retail_asking_price": new Set(["", "High", "Moderate", "Low"]),
  "market_check.market_saturation": new Set(["", "Low", "Moderate", "High"]),
  "market_check.market_velocity": new Set(["", "Fast", "Normal", "Slow"]),
  "market_check.regional_demand": new Set(["", "Strong", "Average", "Weak"]),
};
const FILE_SUMMARY_NUMBER_FIELDS = new Set([
  "total_risk_weighted_value",
  "file_risk_multiplier",
  "commission_percent_no_guarantee",
]);
const FILE_SUMMARY_RATIO_FIELDS = new Set([
  "offer2_nmg_percent",
  "capped_threshold_percent",
]);

function numberOrNull(
  value: unknown,
  input: { max: number; allowNegative?: boolean } = { max: 1_000_000_000_000 }
) {
  if (value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_VALUE_INVALID",
      "Numeric Proposal Valuation fields must contain a finite number or null"
    );
  }
  if ((!input.allowNegative && value < 0) || Math.abs(value) > input.max) {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_VALUE_INVALID",
      "Proposal Valuation value is outside the allowed range"
    );
  }
  return value;
}

function applyProposalValuationChanges(input: {
  sheet: AssetAdminScheduleSheet;
  role: ProposalValuationRole;
  evaluatorColumnId: string | null;
  changes: unknown;
}) {
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_CHANGES_REQUIRED",
      "changes must contain at least one edit"
    );
  }
  if (input.changes.length > MAX_CHANGES_PER_SAVE) {
    throw new ProposalValuationError(
      413,
      "PROPOSAL_VALUATION_CHANGES_TOO_LARGE",
      `A save can contain at most ${MAX_CHANGES_PER_SAVE} changes`
    );
  }

  const next = JSON.parse(JSON.stringify(input.sheet)) as AssetAdminScheduleSheet;
  const rowsById = new Map(next.rows.map((row) => [row.lot_id, row]));
  const columnIds = new Set(next.evaluator_columns.map((column) => column.id));

  for (const rawChange of input.changes as ProposalValuationChange[]) {
    const field = safeString(rawChange?.field, 180);
    if (field.startsWith("file_summary.")) {
      if (input.role !== "owner") {
        throw new ProposalValuationError(
          403,
          "PROPOSAL_VALUATION_FIELD_FORBIDDEN",
          "Evaluators may edit only their assigned evaluator column"
        );
      }
      const key = field.slice("file_summary.".length);
      if (key === "buyers_premium_basis") {
        if (rawChange.value !== "capped" && rawChange.value !== "uncapped") {
          throw new ProposalValuationError(
            400,
            "PROPOSAL_VALUATION_VALUE_INVALID",
            "buyers_premium_basis must be capped or uncapped"
          );
        }
        next.file_summary.buyers_premium_basis = rawChange.value;
      } else if (FILE_SUMMARY_NUMBER_FIELDS.has(key)) {
        (next.file_summary as any)[key] = numberOrNull(rawChange.value, {
          max: 1_000_000_000_000,
          allowNegative: false,
        });
      } else if (FILE_SUMMARY_RATIO_FIELDS.has(key)) {
        const value = numberOrNull(rawChange.value, { max: 1 });
        if (value === null) {
          throw new ProposalValuationError(
            400,
            "PROPOSAL_VALUATION_VALUE_INVALID",
            `${key} cannot be null`
          );
        }
        (next.file_summary as any)[key] = value;
      } else {
        throw new ProposalValuationError(
          400,
          "PROPOSAL_VALUATION_FIELD_INVALID",
          `Unsupported Proposal Valuation field: ${field}`
        );
      }
      continue;
    }

    const lotId = safeString(rawChange?.lotId, 240);
    const row = rowsById.get(lotId);
    if (!row) {
      throw new ProposalValuationError(
        400,
        "PROPOSAL_VALUATION_LOT_INVALID",
        "One or more edited lots no longer exist"
      );
    }

    if (field.startsWith("evaluator_values.")) {
      const columnId = field.slice("evaluator_values.".length);
      if (!columnIds.has(columnId)) {
        throw new ProposalValuationError(
          400,
          "PROPOSAL_VALUATION_COLUMN_INVALID",
          "The selected evaluator column no longer exists"
        );
      }
      if (
        input.role === "evaluator" &&
        (!input.evaluatorColumnId || columnId !== input.evaluatorColumnId)
      ) {
        throw new ProposalValuationError(
          403,
          "PROPOSAL_VALUATION_FIELD_FORBIDDEN",
          "Evaluators may edit only their assigned evaluator column"
        );
      }
      row.evaluator_values[columnId] = numberOrNull(rawChange.value, {
        max: 1_000_000_000_000,
      });
      continue;
    }

    if (input.role !== "owner") {
      throw new ProposalValuationError(
        403,
        "PROPOSAL_VALUATION_FIELD_FORBIDDEN",
        "Evaluators may edit only their assigned evaluator column"
      );
    }
    const textLimit = OWNER_TEXT_ROW_FIELDS.get(field);
    if (textLimit) {
      (row as any)[field] = safeString(rawChange.value, textLimit);
      continue;
    }
    if (OWNER_NUMBER_ROW_FIELDS.has(field)) {
      (row as any)[field] = numberOrNull(rawChange.value, {
        max: 1_000_000_000,
      });
      continue;
    }
    if (field === "market_check.notes") {
      row.market_check.notes = safeString(rawChange.value, 4_000);
      continue;
    }
    if (MARKET_CHECK_OPTIONS[field]) {
      const value = safeString(rawChange.value, 40);
      if (!MARKET_CHECK_OPTIONS[field].has(value)) {
        throw new ProposalValuationError(
          400,
          "PROPOSAL_VALUATION_VALUE_INVALID",
          `Invalid value for ${field}`
        );
      }
      const key = field.slice("market_check.".length);
      (row.market_check as any)[key] = value;
      continue;
    }
    throw new ProposalValuationError(
      400,
      "PROPOSAL_VALUATION_FIELD_INVALID",
      `Unsupported Proposal Valuation field: ${field}`
    );
  }

  return calculateAssetAdminScheduleSheet(next);
}

export async function patchProposalValuation(input: {
  reportId: string;
  user: any;
  baseRevision: unknown;
  clientMutationId: unknown;
  changes: unknown;
}) {
  assertProposalValuationEnabled(input.user);
  const userId = plainId(input.user);
  const baseRevision = parseBaseRevision(input.baseRevision);
  const mutationId = cleanMutationId(input.clientMutationId);
  const report = await populatedReport(input.reportId);
  const role = report ? accessRole(report, userId) : null;
  if (!report || !role) {
    throw new ProposalValuationError(
      404,
      "PROPOSAL_VALUATION_NOT_FOUND",
      "Asset report not found"
    );
  }
  assertEditableStatus(report);
  if (mutationAlreadyApplied(report, userId, mutationId, "draft")) {
    return buildProposalValuationWorkspace(report, userId, role, {
      idempotent: true,
    });
  }
  if (currentRevision(report) !== baseRevision) {
    return conflictOrIdempotent(input.reportId, userId, mutationId, "draft");
  }
  assertArtifactPublicationIdle(report);

  const assignment = currentAssignments(report).find(
    (candidate) => plainId(candidate.user) === userId
  );
  const sheet = applyProposalValuationChanges({
    sheet: reportSheet(report),
    role,
    evaluatorColumnId:
      role === "evaluator" ? safeString(assignment?.column_id, 120) : null,
    changes: input.changes,
  });
  const nextRevision = baseRevision + 1;
  const now = new Date();
  const set: Record<string, unknown> = {
    "preview_data.admin_schedule_sheet": sheet,
    proposal_valuation_updated_by: new mongoose.Types.ObjectId(userId),
    proposal_valuation_updated_at: now,
  };
  if (
    report.files_generating ||
    report.files_regenerating ||
    report.excel_regenerating ||
    ["queued", "processing"].includes(String(report.job_status || ""))
  ) {
    set.files_regeneration_pending = true;
  }

  const saved = await AssetReport.findOneAndUpdate(
    {
      _id: report._id,
      status: { $in: ["pending_approval", "approved"] },
      is_draft_preview: { $ne: true },
      ...proposalValuationWritableRevisionCondition(baseRevision),
    },
    {
      $set: set,
      $inc: { proposal_valuation_revision: 1 },
      $push: {
        proposal_valuation_recent_mutations: mutationPush(
          userId,
          mutationId,
          nextRevision,
          "draft"
        ),
      },
    },
    { new: true }
  );
  if (!saved) {
    return conflictOrIdempotent(input.reportId, userId, mutationId, "draft");
  }
  broadcastProposalValuationRevision({
    reportId: input.reportId,
    revision: nextRevision,
    updatedAt: now,
    updatedBy: userId,
    mutationId,
  });
  const populated = await populatedReport(input.reportId);
  return buildProposalValuationWorkspace(populated, userId, role);
}

export async function getProposalValuationRegenerationContext(
  input: {
    reportId: string;
    user: any;
    baseRevision: unknown;
    clientMutationId: unknown;
  }
) {
  assertProposalValuationEnabled(input.user);
  const userId = plainId(input.user);
  const baseRevision = parseBaseRevision(input.baseRevision);
  const mutationId = cleanMutationId(input.clientMutationId);
  const report = await populatedReport(input.reportId);
  if (!report || plainId(report.user) !== userId) {
    throw new ProposalValuationError(
      404,
      "PROPOSAL_VALUATION_NOT_FOUND",
      "Asset report not found"
    );
  }
  assertEditableStatus(report);
  if (mutationAlreadyApplied(report, userId, mutationId, "regenerate")) {
    if (regenerationIsDurablyRequested(report)) {
      return {
        reportId: plainId(report._id),
        revision: currentRevision(report),
        mutationId,
        idempotent: true,
      };
    }
    const existingClaim = matchingMutation(
      report,
      userId,
      mutationId,
      "regenerate"
    );
    const claimAgeMs = Date.now() - new Date(existingClaim?.created_at || 0).getTime();
    if (Number.isFinite(claimAgeMs) && claimAgeMs < 2 * 60 * 1_000) {
      regenerationClaimInProgress(report);
    }
    // A process may have stopped after claiming the idempotency key but before
    // queueing. Expire only an inactive old claim; the conditional claim below
    // still guarantees one retry wins.
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $pull: {
          proposal_valuation_recent_mutations: {
            id: mutationId,
            user: new mongoose.Types.ObjectId(userId),
            kind: "regenerate",
          },
        },
      }
    );
  }
  if (currentRevision(report) !== baseRevision) {
    throw new ProposalValuationError(
      409,
      "PV_REVISION_CONFLICT",
      "Proposal Valuation changed in another session. Reload the latest revision and try again.",
      { currentRevision: currentRevision(report) }
    );
  }

  const claimFilter: any = {
    _id: report._id,
    user: new mongoose.Types.ObjectId(userId),
    is_draft_preview: { $ne: true },
    ...revisionFilter(baseRevision),
    proposal_valuation_recent_mutations: {
      $not: {
        $elemMatch: {
          id: mutationId,
          user: new mongoose.Types.ObjectId(userId),
          kind: "regenerate",
        },
      },
    },
  };
  const claimed = await AssetReport.findOneAndUpdate(
    claimFilter,
    {
      $push: {
        proposal_valuation_recent_mutations: mutationPush(
          userId,
          mutationId,
          baseRevision,
          "regenerate"
        ),
      },
    },
    { new: true }
  );
  if (!claimed) {
    const latest = await populatedReport(input.reportId);
    if (
      latest &&
      mutationAlreadyApplied(latest, userId, mutationId, "regenerate")
    ) {
      if (regenerationIsDurablyRequested(latest)) {
        return {
          reportId: plainId(latest._id),
          revision: currentRevision(latest),
          mutationId,
          idempotent: true,
        };
      }
      regenerationClaimInProgress(latest);
    }
    throw new ProposalValuationError(
      409,
      "PV_REVISION_CONFLICT",
      "Proposal Valuation changed in another session. Reload the latest revision and try again.",
      { currentRevision: currentRevision(latest) }
    );
  }
  return {
    reportId: plainId(report._id),
    revision: baseRevision,
    mutationId,
    idempotent: false,
  };
}

export async function releaseProposalValuationRegenerationClaim(input: {
  reportId: string;
  userId: string;
  mutationId: string;
}) {
  await AssetReport.updateOne(
    { _id: input.reportId },
    {
      $pull: {
        proposal_valuation_recent_mutations: {
          id: input.mutationId,
          user: new mongoose.Types.ObjectId(input.userId),
          kind: "regenerate",
        },
      },
    }
  );
}

export function proposalValuationErrorBody(error: ProposalValuationError) {
  return {
    code: error.code,
    message: error.message,
    ...error.details,
  };
}
