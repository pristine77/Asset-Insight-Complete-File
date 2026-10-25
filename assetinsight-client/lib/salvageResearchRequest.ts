/** Persist the logical paid-action ID before dispatch; unknown outcomes reuse it. */
export function salvageResearchRequestKey(reportId: string, revision: number): string {
  return `cv:salvage-research:${reportId}:${revision}`;
}
export function salvageResearchRequestId(reportId: string, revision: number): string {
  const key = salvageResearchRequestKey(reportId, revision);
  const previous = sessionStorage.getItem(key);
  if (previous) return previous;
  const id = crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return id;
}
