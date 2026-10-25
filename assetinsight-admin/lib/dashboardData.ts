export type WorkflowStage = 'preparing_preview' | 'preview_ready' | 'generating_files' | 'awaiting_approval' | 'awaiting_release' | 'ready' | 'error';
export type DashboardRecentReport = {
  _id: string; title: string; contractNo?: string | null; type: string; lotCount: number;
  lotNumberSummary?: string | null; thumbnailUrl?: string | null;
  owner?: { username?: string | null; companyName?: string | null; email?: string | null } | string | null;
  createdAt: string; status?: string | null; releaseStatus?: string | null;
};
export type DashboardQueueItem = {
  id: string; reportType: string; title: string; contractNo?: string; creator: string;
  creatorEmail?: string; lotCount: number; thumbnailUrl?: string | null;
  workflowStage: WorkflowStage; workflowMessage: string; elapsedMinutes: number; error?: string | null;
};
type Metric = { value: number; percent?: number };
export type DashboardRange = { from: string; to: string };
export type DesktopDashboard = {
  range: DashboardRange;
  kpis: { reports: Metric; lots: Metric; lotListings: Metric; users: Metric; pending: number; released: number };
  activity: { date: string; value: number | null }[];
  byType: { type: string; value: number }[];
  queue: { preparingPreview: number; previewReady: number; generatingFiles: number; awaitingApproval: number; awaitingRelease: number; releasedToday: number; items: DashboardQueueItem[] };
  recentReports: DashboardRecentReport[];
};
export type ActivityBucket = { date: string; endDate: string; value: number | null };
const DAY = 86_400_000;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(value: string): number | null {
  if (!dateOnly.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time / DAY : null;
}

export function validateDashboardRange({ from, to }: DashboardRange): string | null {
  const start = dayNumber(from), end = dayNumber(to);
  if (start === null || end === null) return 'Choose a valid start and end date.';
  return start > end ? 'The end date must be on or after the start date.' : null;
}

export const formatCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString() : '—';
export function formatDay(value: string, withYear = false) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
}
export const reportTypeLabel = (type: string) => ({ LotListing: 'Lot Listing', lotListing: 'Lot Listing', RealEstate: 'Real Estate', realEstate: 'Real Estate', asset: 'Asset', salvage: 'Salvage' }[type] || type);
export const workflowLabels: Record<WorkflowStage, string> = {
  preparing_preview: 'Preparing previews', preview_ready: 'Preview ready', generating_files: 'Generating files',
  awaiting_approval: 'Awaiting approval', awaiting_release: 'Awaiting release', ready: 'Ready today', error: 'Needs attention',
};
export function reportStatus(report: Pick<DashboardRecentReport, 'status' | 'releaseStatus'>): { label: string; tone: 'success' | 'warning' | 'error' | 'info' | 'default' } {
  const status = report.status?.toLowerCase();
  if (status === 'error' || status === 'failed') return { label: 'Failed', tone: 'error' };
  if (status === 'declined' || status === 'rejected') return { label: 'Declined', tone: 'error' };
  if (status === 'released') return { label: 'Released', tone: 'success' };
  // Legacy payloads default missing release_status to released even for unfinished previews.
  if (status === 'approved' || status === 'completed') return { label: report.releaseStatus === 'released' ? 'Released' : status === 'approved' ? 'Approved' : 'Completed', tone: 'success' };
  if (status === 'pending_approval') return { label: 'Pending approval', tone: 'warning' };
  if (status === 'processing' || status === 'generating') return { label: 'Processing', tone: 'warning' };
  if (status === 'preview') return { label: 'Preview ready', tone: 'info' };
  return { label: status ? status.replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Unknown', tone: 'default' };
}

/** Bounded contiguous date bins preserve totals; absent/invalid days remain unknown, never zero. */
export function prepareActivity(activity: DesktopDashboard['activity'], range: DashboardRange, maxPoints = 180): ActivityBucket[] {
  const first = dayNumber(range.from.slice(0, 10)), last = dayNumber(range.to.slice(0, 10));
  if (first === null || last === null || first > last) return [];
  const limit = Number.isFinite(maxPoints) ? Math.max(1, Math.floor(maxPoints)) : 180;
  const span = last - first + 1, width = Math.ceil(span / limit);
  const days = new Map<number, number | null>();
  for (const point of activity) {
    const day = dayNumber(point.date.slice(0, 10));
    if (day === null || day < first || day > last) continue;
    const value = typeof point.value === 'number' && Number.isFinite(point.value) && point.value >= 0 ? point.value : null;
    days.set(day, value === null || days.get(day) === null ? null : (days.get(day) ?? 0) + value);
  }
  const buckets = Array.from({ length: Math.ceil(span / width) }, (_, index) => {
    const start = first + index * width, end = Math.min(last, start + width - 1);
    return { date: new Date(start * DAY).toISOString().slice(0, 10), endDate: new Date(end * DAY).toISOString().slice(0, 10), value: 0 as number | null, present: 0, expected: end - start + 1 };
  });
  for (const [day, value] of days) {
    const bucket = buckets[Math.floor((day - first) / width)];
    bucket.present++;
    bucket.value = value === null || bucket.value === null ? null : bucket.value + value;
  }
  return buckets.map(({ date, endDate, value, present, expected }) => ({ date, endDate, value: present === expected ? value : null }));
}

const dashboardReportTypes = new Set(['Asset', 'LotListing', 'RealEstate', 'Salvage']);
const dashboardWorkflowStages = new Set(Object.keys(workflowLabels));
const queueCountKeys = ['preparingPreview', 'previewReady', 'generatingFiles', 'awaitingApproval', 'awaitingRelease', 'releasedToday'];
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';
const isNullableString = (value: unknown) => value === null || isOptionalString(value);
const isNonemptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Accept date-only fixtures and the UTC ISO timestamps emitted by JSON dates. */
function isDashboardDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (dateOnly.test(value)) return dayNumber(value) !== null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

function isMetric(value: unknown): boolean {
  return isRecord(value) && isCount(value.value) &&
    (value.percent === undefined || (typeof value.percent === 'number' && Number.isFinite(value.percent)));
}

function isQueueItem(value: unknown): boolean {
  return isRecord(value) && isNonemptyString(value.id) && isNonemptyString(value.reportType) &&
    typeof value.title === 'string' && typeof value.creator === 'string' &&
    isOptionalString(value.contractNo) && isOptionalString(value.creatorEmail) &&
    isCount(value.lotCount) && isNullableString(value.thumbnailUrl) &&
    typeof value.workflowStage === 'string' && dashboardWorkflowStages.has(value.workflowStage) &&
    typeof value.workflowMessage === 'string' && isCount(value.elapsedMinutes) && isNullableString(value.error);
}

function isRecentReport(value: unknown): boolean {
  if (!isRecord(value) || !isNonemptyString(value._id) || typeof value.title !== 'string' ||
    !isNonemptyString(value.type) || !isCount(value.lotCount) || !isDashboardDate(value.createdAt) ||
    !isNullableString(value.contractNo) || !isNullableString(value.lotNumberSummary) ||
    !isNullableString(value.thumbnailUrl) || !isNullableString(value.status) || !isNullableString(value.releaseStatus)) return false;
  const owner = value.owner;
  return owner === undefined || owner === null || typeof owner === 'string' ||
    (isRecord(owner) && ['username', 'companyName', 'email'].every(key => isNullableString(owner[key])));
}

/** Validate every rendered field before replacing the last successful snapshot. */
export function isDesktopDashboard(value: unknown): value is DesktopDashboard {
  if (!isRecord(value) || !isRecord(value.range) || !isDashboardDate(value.range.from) ||
    !isDashboardDate(value.range.to) || Date.parse(value.range.from) > Date.parse(value.range.to)) return false;
  const { kpis, queue, activity, byType, recentReports } = value;
  if (!isRecord(kpis) || !['reports', 'lots', 'lotListings', 'users'].every(key => isMetric(kpis[key])) ||
    !isCount(kpis.pending) || !isCount(kpis.released)) return false;
  if (!isRecord(queue) || !queueCountKeys.every(key => isCount(queue[key])) ||
    !Array.isArray(queue.items) || !queue.items.every(isQueueItem)) return false;
  if (!Array.isArray(activity) || !activity.every(point => isRecord(point) && isDashboardDate(point.date) &&
    (point.value === null || isCount(point.value)))) return false;
  if (!Array.isArray(byType) || byType.length !== dashboardReportTypes.size ||
    !byType.every(row => isRecord(row) && typeof row.type === 'string' && dashboardReportTypes.has(row.type) && isCount(row.value)) ||
    new Set(byType.map(row => row.type)).size !== dashboardReportTypes.size) return false;
  return Array.isArray(recentReports) && recentReports.every(isRecentReport);
}
