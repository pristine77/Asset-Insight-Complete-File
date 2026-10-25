/** Review identities are provisioned by operators, never selected by a client. */
export function isReviewAccount(user: unknown): boolean {
  return Boolean(user && typeof user === "object" && (user as any).isReviewAccount === true);
}

export function normalCrmUserFilter() {
  return { isReviewAccount: { $ne: true } };
}

export function crmUserCohortFilter(user: unknown) {
  return isReviewAccount(user) ? { isReviewAccount: true } : normalCrmUserFilter();
}

/** Legacy records stay production data; review data must carry server provenance. */
export function crmLeadCohortFilter(user: unknown) {
  return isReviewAccount(user) ? { isReviewData: true } : { isReviewData: { $ne: true } };
}

export function sameCrmCohort(left: unknown, right: unknown): boolean {
  return isReviewAccount(left) === isReviewAccount(right);
}
