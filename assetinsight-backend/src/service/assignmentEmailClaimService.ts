/**
 * Atomically reserves assignment-email delivery after a report generation has
 * been durably published. The claim intentionally gives at-most-once delivery:
 * a process crash after provider acceptance cannot safely distinguish accepted
 * from unsent mail, so later attempts retain the generation-bound claim instead
 * of risking a duplicate external notification.
 */
import { sendAssignedApprovalEmail } from "./approvalAssignmentService.js";
import { sendAssignedReleaseEmail } from "./reportReleaseService.js";

export type AssignmentEmailKind = "approval" | "release";

export async function sendClaimedAssignmentEmail(input: {
  model: any;
  reportId: unknown;
  kind: AssignmentEmailKind;
  generationToken: string;
  ownershipFilter: Record<string, unknown>;
  stateFilter: Record<string, unknown>;
  reportType: string;
  creatorUserId?: unknown;
  title?: string;
  summary?: string;
}): Promise<boolean> {
  const sentField = `${input.kind}_assignment_email_sent_at`;
  const claimField = `${input.kind}_assignment_email_claim_token`;
  const assignedField = `${input.kind}_assigned_to`;
  const claimToken = `${input.kind}:${input.generationToken}`;

  const report = await input.model
    .findOneAndUpdate(
      {
        _id: input.reportId,
        ...input.ownershipFilter,
        ...input.stateFilter,
        [assignedField]: { $ne: null },
        [sentField]: null,
        // The same generation can claim exactly once. A later generation may
        // deliberately notify again only when its workflow cleared sent_at.
        [claimField]: { $ne: claimToken },
      },
      { $set: { [claimField]: claimToken } },
      { new: true },
    )
    .select(`+${claimField}`);
  if (!report) return false;

  const sendOptions = {
    reportType: input.reportType,
    creatorUserId: input.creatorUserId || report.user,
    title: input.title,
    summary: input.summary,
  };
  const sent =
    input.kind === "approval"
      ? await sendAssignedApprovalEmail(report, sendOptions)
      : await sendAssignedReleaseEmail(report, sendOptions);
  if (!sent) return false;

  const sentAt = report[sentField];
  const persisted = await input.model.updateOne(
    {
      _id: input.reportId,
      ...input.ownershipFilter,
      [claimField]: claimToken,
    },
    { $set: { [sentField]: sentAt || new Date() } },
  );
  if (persisted.matchedCount !== 1) {
    throw Object.assign(
      new Error(
        `Report generation lost ownership while recording its ${input.kind} assignment email.`,
      ),
      { code: "ASSIGNMENT_EMAIL_MARKER_OWNERSHIP_LOST" },
    );
  }
  return true;
}
