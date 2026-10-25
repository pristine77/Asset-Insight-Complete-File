import { Types } from "mongoose";
import User from "../models/user.model.js";

/** Reviewer workflow permissions are self-only, never a route to customer work. */
export async function assertReviewWorkflowAssignment(owner: any, assigneeId: unknown) {
  if (!assigneeId) return;
  const target = await User.findById(assigneeId).select("isReviewAccount").lean();
  if (owner?.isReviewAccount === true || target?.isReviewAccount === true) {
    if (owner?.isReviewAccount !== true || String(owner._id) !== String(assigneeId)) {
      throw new Error("Review accounts can only approve and release their own test reports.");
    }
  }
}

export async function resolveIsolatedWorkflowAssignee(
  userId: Types.ObjectId,
  field: "reportApprover" | "releaseManager",
): Promise<Types.ObjectId | null> {
  const owner = await User.findById(userId).select(`${field} isReviewAccount`).lean();
  const assignee = owner?.[field];
  if (!assignee) return null;
  if (owner.isReviewAccount === true) {
    return String(assignee) === String(owner._id) ? new Types.ObjectId(String(owner._id)) : null;
  }
  const reviewTarget = await User.exists({ _id: assignee, isReviewAccount: true });
  return reviewTarget ? null : new Types.ObjectId(String(assignee));
}
