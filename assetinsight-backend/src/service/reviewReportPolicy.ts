import User from "../models/user.model.js";
import ReviewAccountBoundary from "../models/reviewAccountBoundary.model.js";

/** Fresh egress check, including queued work whose review identity was deleted. */
export async function isReviewReportOwnerId(value: unknown): Promise<boolean> {
  const id = String(value || "");
  if (!/^[a-f\d]{24}$/i.test(id)) return false;
  const [current, enrolled] = await Promise.all([
    User.exists({ _id: id, isReviewAccount: true }),
    ReviewAccountBoundary.exists({ _id: id }),
  ]);
  return Boolean(current || enrolled);
}

/** The isolated realm survives account/security deletion. Deleting a review
 * identity must never republish retained demo reports into customer feeds. */
export async function productionReportOwnerFilter(): Promise<Record<string, any>> {
  const [current, enrolled] = await Promise.all([
    User.distinct("_id", { isReviewAccount: true }),
    ReviewAccountBoundary.distinct("_id"),
  ]);
  const ids = [...current, ...enrolled];
  return ids.length ? { user: { $nin: ids } } : {};
}
