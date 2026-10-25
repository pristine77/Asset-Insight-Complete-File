import { Types } from "mongoose";

export const REPORT_APPROVAL_DECISION_CONFLICT =
  "REPORT_APPROVAL_DECISION_CONFLICT";

export class ReportApprovalDecisionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = REPORT_APPROVAL_DECISION_CONFLICT;

  constructor(public readonly currentStatus: string) {
    super(
      currentStatus
        ? `This report was already changed to ${currentStatus}. Refresh before making another approval decision.`
        : "This report changed while the approval decision was being saved. Refresh and retry."
    );
    this.name = "ReportApprovalDecisionConflictError";
  }
}

function objectIdFrom(value: unknown): Types.ObjectId | null {
  if (!value) return null;
  if (value instanceof Types.ObjectId) return value;
  const candidate =
    typeof value === "object" && value !== null && "_id" in value
      ? (value as any)._id
      : value;
  const raw = String(candidate || "").trim();
  return Types.ObjectId.isValid(raw) ? new Types.ObjectId(raw) : null;
}

function approvalAssignmentSnapshotCondition(report: any) {
  const assignedTo = objectIdFrom(report?.approval_assigned_to);
  return assignedTo
    ? { approval_assigned_to: assignedTo }
    : {
        $or: [
          { approval_assigned_to: { $exists: false } },
          { approval_assigned_to: null },
        ],
      };
}

export type ReportApprovalDecisionClaim = {
  claimed: boolean;
  report: any;
};

/**
 * Atomically owns one approval decision before any email or notification is
 * emitted. The timestamp and assignment snapshot fence stale browser tabs,
 * while a retry of the already-persisted same decision is treated as success
 * without replaying external side effects.
 */
export async function claimReportApprovalDecision(input: {
  model: any;
  report: any;
  pendingStatus: string;
  targetStatus: string;
  statusField?: string;
  set?: Record<string, unknown>;
  unset?: Record<string, 1>;
  populate?: string;
}): Promise<ReportApprovalDecisionClaim> {
  const statusField = input.statusField || "status";
  const expectedUpdatedAt = input.report?.updatedAt;
  const filter = {
    _id: input.report?._id,
    [statusField]: input.pendingStatus,
    ...(expectedUpdatedAt ? { updatedAt: expectedUpdatedAt } : {}),
    ...approvalAssignmentSnapshotCondition(input.report),
  };
  const update = {
    $set: {
      ...(input.set || {}),
      [statusField]: input.targetStatus,
    },
    ...(input.unset && Object.keys(input.unset).length
      ? { $unset: input.unset }
      : {}),
  };

  let claimQuery = input.model.findOneAndUpdate(filter, update, {
    returnDocument: "after",
    runValidators: true,
  });
  if (input.populate) claimQuery = claimQuery.populate(input.populate);
  const claimed = await claimQuery;
  if (claimed) return { claimed: true, report: claimed };

  let currentQuery = input.model.findById(input.report?._id);
  if (input.populate) currentQuery = currentQuery.populate(input.populate);
  const current = await currentQuery;
  const currentStatus = String(current?.[statusField] || "");
  if (current && currentStatus === input.targetStatus) {
    return { claimed: false, report: current };
  }

  throw new ReportApprovalDecisionConflictError(currentStatus);
}

export function releaseFieldsForApprovalDecision(report: any) {
  return {
    release_status: report?.release_status,
    release_assigned_to: objectIdFrom(report?.release_assigned_to),
    release_assigned_at: report?.release_assigned_at || null,
    release_assigned_source: report?.release_assigned_source || "",
    release_assignment_email_sent_at:
      report?.release_assignment_email_sent_at || null,
    released_by: objectIdFrom(report?.released_by),
    released_at: report?.released_at || null,
  };
}
