import { CRM_STATUSES, type GetMyTasksParams } from "@/services/crm";

export type CrmPageName = "dashboard" | "tasks" | "transfers" | "outlook" | "coverage";

/** Route filters are an allowlist; unknown query fields never become API options. */
export function parseCrmTaskQuery(params: Pick<URLSearchParams, "get">): GetMyTasksParams {
  const rawStatus = params.get("status");
  const rawSource = params.get("leadSource");
  const rawDue = params.get("due");
  const rawPage = params.get("page") || "1";
  const page = /^[1-9]\d*$/.test(rawPage) ? Number(rawPage) : 1;
  const q = params.get("q")?.trim().slice(0, 150);
  return {
    page: Number.isSafeInteger(page) && page <= Math.floor(Number.MAX_SAFE_INTEGER / 50) ? page : 1,
    limit: params.get("limit") === "50" ? 50 : 20,
    status: rawStatus === "archived" ? "won" : rawStatus === "all" || CRM_STATUSES.includes(rawStatus as typeof CRM_STATUSES[number]) ? rawStatus as GetMyTasksParams["status"] : undefined,
    leadSource: rawSource === "generic" || rawSource === "organic" ? rawSource : undefined,
    due: rawDue === "overdue" || rawDue === "upcoming" ? rawDue : undefined,
    q: q || undefined,
  };
}

export function crmTaskQueryString(query: GetMyTasksParams): string {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim().slice(0, 150));
  if (query.status) params.set("status", query.status);
  if (query.leadSource) params.set("leadSource", query.leadSource);
  if (query.due) params.set("due", query.due);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  if (query.limit === 50) params.set("limit", "50");
  return params.toString();
}

/** Preserve bookmarked links from the original tabbed CRM without loading its dashboard. */
export function legacyCrmDestination(params: URLSearchParams): string | null {
  const view = params.get("view");
  const page = view === "transfers" || view === "outlook" ? view : params.has("task") || view === "tasks" ? "tasks" : null;
  if (!page) return null;
  const next = new URLSearchParams(params);
  next.delete("view");
  return `/crm/${page}${next.size ? `?${next}` : ""}`;
}
