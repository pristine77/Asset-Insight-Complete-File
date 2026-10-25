import API, { type RetriableAxiosConfig } from "@/lib/api";
import { OutlookService } from "@/services/outlook";
import type { AuthUser } from "@/services/auth";

export const CRM_STATUSES = [
  "new_lead", "contacted", "inspection_required", "inspection_complete",
  "proposal_submitted", "decision_pending", "won", "lost",
] as const;
export type CrmTaskStatus = (typeof CRM_STATUSES)[number];
export type CrmTaskFilterStatus = CrmTaskStatus | "archived" | "all";
export const CRM_OPEN_STATUSES: readonly CrmTaskStatus[] = CRM_STATUSES.filter(
  (status) => status !== "won" && status !== "lost",
);
export const CRM_STATUS_LABELS: Record<CrmTaskStatus, string> = {
  new_lead: "New Lead", contacted: "Contacted", inspection_required: "Inspection Required",
  inspection_complete: "Inspection Complete", proposal_submitted: "Proposal Submitted",
  decision_pending: "Decision Pending", won: "Won", lost: "Lost",
};
export const CRM_LOST_REASONS = ["not_interested", "timing", "competitor", "no_assets"] as const;
export type CrmLostReason = (typeof CRM_LOST_REASONS)[number];
export const CRM_LOST_REASON_LABELS: Record<CrmLostReason, string> = {
  not_interested: "Not Interested", timing: "Timing", competitor: "Competitor", no_assets: "No Assets",
};
export const CRM_SPECIALIZATION_OPTIONS = [
  { value: "industrial_construction", label: "Industrial & Construction" },
  { value: "farm_equipment_sales", label: "Farm & Farm Equipment Sales" },
  { value: "others", label: "Others" },
] as const;
export type CrmSpecializationValue = (typeof CRM_SPECIALIZATION_OPTIONS)[number]["value"];
export type CrmLeadSourceFilter = "generic" | "organic";
export type CrmDueFilter = "upcoming" | "overdue";
export type CrmDashboardTaskFilter = "all" | CrmLeadSourceFilter | CrmDueFilter;
export type CrmPerson = { _id?: string; email?: string; username?: string; role?: string };

export type CrmTaskUpdateEntry = {
  _id?: string;
  comment?: string;
  status: CrmTaskStatus;
  lostReason?: CrmLostReason;
  reminderDate?: string;
  attachmentUrls?: string[];
  recordingUrl?: string;
  createdBy?: CrmPerson | string | null;
  createdAt: string;
  editedAt?: string;
  isDeleted?: boolean;
  deletedAt?: string;
};

export type CrmTaskItem = {
  _id: string;
  title?: string;
  clientName: string;
  companyName?: string;
  email?: string;
  phoneRaw?: string;
  phoneFormatted?: string;
  contactPhones?: string[];
  companyPhones?: string[];
  contactMobilePhones?: string[];
  notes?: string;
  contactSocials?: string;
  contactLocation?: string;
  contactLinkedinUrl?: string;
  companyLinkedinUrl?: string;
  companyLocation?: string;
  quadrant?: string;
  specialization?: string;
  industry?: string;
  website?: string;
  companyWebsiteDomain?: string;
  researchDate?: string;
  department?: string;
  seniority?: string;
  companyDescription?: string;
  companyAnnualRevenue?: number;
  companyRevenueRange?: string;
  companyStaffCount?: number;
  companyStaffCountRange?: string;
  companyFoundedDate?: string;
  companyPostCode?: string;
  sicCode?: string;
  naicsCode?: string;
  importData?: Record<string, unknown>;
  listItems?: string[];
  category?: string;
  leadSource?: CrmLeadSourceFilter;
  status: CrmTaskStatus;
  lostReason?: CrmLostReason;
  priority?: "low" | "medium" | "high";
  callAttempts?: number;
  lastCalledAt?: string;
  statusChangedAt?: string;
  taskStartDate?: string;
  dueDate?: string;
  latestComment?: string;
  latestAttachmentUrls?: string[];
  latestRecordingUrl?: string;
  assignedBy?: CrmPerson | string | null;
  assignedTo?: CrmPerson | string | null;
  updates?: CrmTaskUpdateEntry[];
  updateCount?: number;
  createdAt: string;
  updatedAt: string;
};
export type CrmPage<T> = { items: T[]; total: number; page: number; limit: number };
export type CrmTaskSummary = Pick<CrmTaskItem,
  "_id" | "title" | "clientName" | "companyName" | "email" | "phoneRaw" | "phoneFormatted" |
  "status" | "lostReason" | "leadSource" | "priority" | "dueDate" | "taskStartDate" |
  "latestComment" | "callAttempts" | "lastCalledAt" | "statusChangedAt" | "createdAt" |
  "updatedAt" | "assignedTo" | "assignedBy"
> & { updateCount: number };
export type CrmTasksResponse = CrmPage<CrmTaskSummary> & {
  statusCounts?: Array<{ _id?: CrmTaskStatus; status?: CrmTaskStatus; count: number }>;
  leadSourceCounts?: { total: number; generic: number; organic: number };
};
export type CrmDashboardTask = Pick<CrmTaskItem, "_id" | "title" | "clientName" | "companyName" | "status" | "lostReason" | "taskStartDate"> & { dueDate: string };
export type CrmDashboardSnapshot = {
  asOf: string;
  total: number;
  statusCounts: Array<{ _id: CrmTaskStatus; count: number }>;
  leadSourceCounts: { total: number; generic: number; organic: number };
  dueCounts: { overdue: number; upcoming: number };
  overdueTasks: CrmDashboardTask[];
  upcomingTasks: CrmDashboardTask[];
};
export type CrmTransferStatus = "pending" | "accepted" | "rejected" | "cancelled";
export type CrmTransferAgent = CrmPerson & {
  _id: string;
  crmAddress?: string;
  crmQuadrant?: string;
  crmSpecializations?: string[];
};
export type CrmTaskTransferItem = {
  _id: string;
  leadId?: Pick<CrmTaskItem, "_id" | "clientName" | "title" | "status" | "dueDate"> | null;
  fromUserId?: CrmPerson | null;
  toUserId?: CrmPerson | null;
  requestedBy?: string;
  status: CrmTransferStatus;
  note?: string;
  respondedAt?: string;
  respondedBy?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type CrmReadOptions = { signal?: AbortSignal };
export type GetMyTasksParams = {
  q?: string;
  status?: CrmTaskFilterStatus;
  leadSource?: CrmLeadSourceFilter;
  due?: CrmDueFilter;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
};
export type EditTaskUpdatePayload = {
  comment?: string;
  status?: CrmTaskStatus;
  lostReason?: CrmLostReason;
};
export type SubmitTaskUpdatePayload = EditTaskUpdatePayload & {
  attachments?: File[];
  recording?: File | null;
};
export type QuickAddLeadPayload = {
  name: string;
  phone: string;
  notes?: string;
  specialization: CrmSpecializationValue;
  category?: string;
  dueDate?: string;
};
export type CrmEmailRewritePayload = {
  body: string;
  subject?: string;
  clientName?: string;
  senderName?: string;
  senderCompany?: string;
};
export type CrmCalendarEvent = { eventId?: string; webLink?: string };
export type CrmCalendarSync = CrmCalendarEvent | {
  pending: true;
  message: string;
  eventId?: never;
  webLink?: never;
};
export type CrmBulkCalendarResponse = {
  createdCount: number;
  failedCount: number;
  created: Array<CrmCalendarEvent & { taskId: string }>;
  failed: Array<{ taskId: string; reason: string }>;
  pendingCount?: number;
  pending?: Array<{ taskId: string; reason: string }>;
};

export const CRM_READ_TIMEOUT_MS = 20_000;
export const CRM_MAX_ATTACHMENTS = 10;
export const CRM_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const CRM_MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

function readOptions(options: CrmReadOptions = {}) {
  return { signal: options.signal, timeout: CRM_READ_TIMEOUT_MS };
}

// CRM writes are not idempotent. Suppress the shared Axios interceptor's
// automatic 401 replay as well as avoiding any service-level mutation retry.
const mutationOptions: RetriableAxiosConfig = { _retry: true };

export function isCrmId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
}
function resourceId(value: string) {
  if (!isCrmId(value)) throw new Error("Invalid CRM record ID.");
  return encodeURIComponent(value);
}
function taskPath(taskId: string) {
  return `/crm/tasks/${resourceId(taskId)}`;
}
function updatePath(taskId: string, updateId: string) {
  return `${taskPath(taskId)}/updates/${resourceId(updateId)}`;
}

export function escapeCrmSearchQuery(value: string) {
  // The existing backend interprets q as a regular expression. A web search is
  // literal text, including punctuation such as parentheses, brackets and +.
  return value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function safeCrmUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
  try {
    const url = new URL(value.trim());
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function crmErrorMessage(error: unknown, fallback = "The CRM request could not be completed."): string {
  const failure = record(error);
  const body = record(record(failure.response).data);
  const nested = record(body.error);
  const message = text(body.message) || text(body.error) || text(nested.message) || text(failure.message) || fallback;
  const rawCode = text(body.code) || text(nested.code);
  const code = rawCode && /^[a-z][a-z\d_-]{0,95}$/i.test(rawCode) ? rawCode : undefined;
  return code && !message.toUpperCase().includes(code.toUpperCase()) ? `${message} (${code})` : message;
}

/** A comment/media update must not reset scheduling by resending the current status. */
export function crmStatusChange(
  currentStatus: CrmTaskStatus,
  nextStatus: CrmTaskStatus,
  lostReason?: CrmLostReason,
): Pick<EditTaskUpdatePayload, "status" | "lostReason"> {
  if (nextStatus === currentStatus) return {};
  if (nextStatus === "lost") {
    if (!lostReason || !CRM_LOST_REASONS.includes(lostReason)) {
      throw new Error("Select a reason before marking this task as Lost.");
    }
    return { status: nextStatus, lostReason };
  }
  return { status: nextStatus };
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function dashboardTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
/** Never turn a partial dashboard or page-limited rows into authoritative zeros. */
export function parseCrmDashboard(value: unknown): CrmDashboardSnapshot {
  const data = record(value);
  const source = record(data.leadSourceCounts);
  const due = record(data.dueCounts);
  const invalid = () => new Error("The server returned an incomplete CRM dashboard. Please refresh.");
  if (!dashboardTimestamp(data.asOf) || !integer(data.total, 0) || !Array.isArray(data.statusCounts) || data.statusCounts.length !== CRM_STATUSES.length ||
    !integer(source.total, 0) || !integer(source.generic, 0) || !integer(source.organic, 0) || source.total !== data.total || source.generic + source.organic !== data.total ||
    !integer(due.overdue, 0) || !integer(due.upcoming, 0)) throw invalid();
  const counts = new Map<CrmTaskStatus, number>();
  for (const value of data.statusCounts) {
    const entry = record(value);
    if (typeof entry._id !== "string" || !CRM_STATUSES.includes(entry._id as CrmTaskStatus) || counts.has(entry._id as CrmTaskStatus) || !integer(entry.count, 0)) throw invalid();
    counts.set(entry._id as CrmTaskStatus, entry.count);
  }
  if (Array.from(counts.values()).reduce((sum, count) => sum + count, 0) !== data.total) throw invalid();
  const openTotal = CRM_OPEN_STATUSES.reduce((sum, status) => sum + (counts.get(status) || 0), 0);
  if (due.overdue + due.upcoming > openTotal) throw invalid();
  const asOf = Date.parse(data.asOf);
  const ids = new Set<string>();
  function tasks(value: unknown, total: number, group: "overdue" | "upcoming"): CrmDashboardTask[] {
    if (!Array.isArray(value) || value.length !== Math.min(total, 5)) throw invalid();
    return value.map((raw) => {
      const item = record(raw);
      if (typeof item._id !== "string" || !isCrmId(item._id) || ids.has(item._id) || typeof item.clientName !== "string" ||
        !CRM_OPEN_STATUSES.includes(item.status as CrmTaskStatus) || !dashboardTimestamp(item.dueDate) ||
        (item.taskStartDate != null && !dashboardTimestamp(item.taskStartDate)) ||
        (item.title != null && typeof item.title !== "string") || (item.companyName != null && typeof item.companyName !== "string") ||
        (item.lostReason != null && !CRM_LOST_REASONS.includes(item.lostReason as CrmLostReason))) throw invalid();
      const time = Date.parse(item.dueDate);
      if (group === "overdue" ? time >= asOf : time < asOf || time > asOf + 7 * 24 * 60 * 60 * 1000) throw invalid();
      ids.add(item._id);
      return { _id: item._id, clientName: item.clientName, status: item.status as CrmTaskStatus, dueDate: item.dueDate,
        ...(item.title != null ? { title: item.title as string } : {}),
        ...(item.companyName != null ? { companyName: item.companyName as string } : {}),
        ...(item.lostReason != null ? { lostReason: item.lostReason as CrmLostReason } : {}),
        ...(item.taskStartDate != null ? { taskStartDate: item.taskStartDate as string } : {}),
      };
    });
  }
  return {
    asOf: data.asOf, total: data.total,
    statusCounts: CRM_STATUSES.map((_id) => ({ _id, count: counts.get(_id)! })),
    leadSourceCounts: { total: source.total, generic: source.generic, organic: source.organic },
    dueCounts: { overdue: due.overdue, upcoming: due.upcoming },
    overdueTasks: tasks(data.overdueTasks, due.overdue, "overdue"),
    upcomingTasks: tasks(data.upcomingTasks, due.upcoming, "upcoming"),
  };
}
function checkedPage<T>(value: unknown): CrmPage<T> {
  const data = record(value);
  if (!Array.isArray(data.items) || !integer(data.total, 0) || !integer(data.page, 1) || !integer(data.limit, 1)) {
    throw new Error("The server returned an incomplete CRM page. Please refresh.");
  }
  return data as CrmPage<T>;
}
function checkedItem<T>(value: unknown): T {
  const item = record(record(value).item);
  if (typeof item._id !== "string" || !item._id) {
    throw new Error("The server did not return the CRM record. Refresh to check its current state.");
  }
  return item as T;
}
function checkedItems<T>(value: unknown): T[] {
  const items = record(value).items;
  if (!Array.isArray(items)) throw new Error("The server returned an incomplete CRM list. Please refresh.");
  return items as T[];
}
function boundedPage(value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  return value !== undefined && integer(value, 1) ? Math.min(value, maximum) : fallback;
}
function validateFile(file: File, maximum: number) {
  if (!file.size || file.size > maximum) {
    throw new Error(`Choose a nonempty file no larger than ${maximum / 1024 / 1024} MiB.`);
  }
}

function calendarEvent(value: unknown): CrmCalendarEvent {
  const data = record(value);
  const rawId = text(data.eventId);
  const eventId = rawId && /^[a-z\d][a-z\d._~+/=-]{0,4095}$/i.test(rawId) ? rawId : undefined;
  const webLink = safeCrmUrl(data.webLink);
  if (data.pending || (!eventId && !webLink)) {
    throw new Error("Outlook did not return a verifiable event. Check your calendar before trying again.");
  }
  return { eventId, webLink };
}

function checkedCalendarBatch(value: unknown, taskIds: string[]): CrmBulkCalendarResponse {
  const data = record(value);
  const failure = () => new Error("The server returned incomplete calendar results. Check your calendar before trying again.");
  if (!integer(data.createdCount, 0) || !integer(data.failedCount, 0) || !Array.isArray(data.created) || !Array.isArray(data.failed) || data.createdCount !== data.created.length || data.failedCount !== data.failed.length) {
    throw failure();
  }
  const attempted = new Set(taskIds);
  const seen = new Set<string>();
  const checkedId = (entry: Record<string, unknown>) => {
    if (typeof entry.taskId !== "string" || !attempted.has(entry.taskId) || seen.has(entry.taskId)) throw failure();
    seen.add(entry.taskId);
    return entry.taskId;
  };
  const created = data.created.map((value) => {
    const entry = record(value);
    const taskId = checkedId(entry);
    return { taskId, ...calendarEvent(entry) };
  });
  const failed = data.failed.map((value) => {
    const entry = record(value);
    const taskId = checkedId(entry);
    const reason = text(entry.reason);
    if (!reason) throw failure();
    return { taskId, reason };
  });
  let pending: CrmBulkCalendarResponse["pending"];
  if (data.pendingCount !== undefined || data.pending !== undefined) {
    if (!integer(data.pendingCount, 0) || !Array.isArray(data.pending) || data.pendingCount !== data.pending.length) throw failure();
    pending = data.pending.map((value) => {
      const entry = record(value);
      const taskId = checkedId(entry);
      const reason = text(entry.reason);
      if (!reason || entry.eventId || entry.webLink) throw failure();
      return { taskId, reason };
    });
  }
  // Omitted attempted IDs stay omitted; the caller presents that uncertainty.
  return { createdCount: data.createdCount, failedCount: data.failedCount, created, failed,
    ...(pending ? { pendingCount: pending.length, pending } : {}) };
}

export const CrmService = {
  async getDashboard(options?: CrmReadOptions): Promise<CrmDashboardSnapshot> {
    const { data } = await API.get("/crm/tasks/dashboard", readOptions(options));
    return parseCrmDashboard(data);
  },

  async getMyTasks(params: GetMyTasksParams = {}, options?: CrmReadOptions): Promise<CrmTasksResponse> {
    const query = {
      ...params,
      q: params.q?.trim() ? escapeCrmSearchQuery(params.q) : undefined,
      page: boundedPage(params.page, 1),
      limit: boundedPage(params.limit, 20, 200),
      view: "summary",
    };
    const { data } = await API.get("/crm/tasks/my", { ...readOptions(options), params: query });
    checkedPage<CrmTaskItem>(data);
    return data as CrmTasksResponse;
  },

  async getTask(taskId: string, options?: CrmReadOptions): Promise<CrmTaskItem> {
    const { data } = await API.get(taskPath(taskId), readOptions(options));
    return checkedItem<CrmTaskItem>(data);
  },

  async getTaskUpdates(taskId: string, params: { page?: number; limit?: number } = {}, options?: CrmReadOptions): Promise<CrmPage<CrmTaskUpdateEntry>> {
    const { data } = await API.get(`${taskPath(taskId)}/updates`, {
      ...readOptions(options),
      params: { page: boundedPage(params.page, 1), limit: boundedPage(params.limit, 20, 50) },
    });
    return checkedPage<CrmTaskUpdateEntry>(data);
  },

  async quickAddLead(payload: QuickAddLeadPayload, options?: CrmReadOptions): Promise<CrmTaskItem> {
    const { data } = await API.post("/crm/tasks/quick-add", payload, { ...mutationOptions, ...(options?.signal ? { signal: options.signal } : {}) });
    return checkedItem<CrmTaskItem>(data);
  },

  async submitTaskUpdate(taskId: string, payload: SubmitTaskUpdatePayload): Promise<CrmTaskItem> {
    const path = `${taskPath(taskId)}/update`;
    if ((payload.attachments?.length || 0) > CRM_MAX_ATTACHMENTS) throw new Error("Choose no more than 10 attachments per update.");
    const form = new FormData();
    if (payload.comment?.trim()) form.append("comment", payload.comment.trim());
    if (payload.status) form.append("status", payload.status);
    if (payload.lostReason) form.append("lostReason", payload.lostReason);
    for (const file of payload.attachments || []) {
      validateFile(file, CRM_MAX_ATTACHMENT_BYTES);
      form.append("attachments", file, file.name);
    }
    if (payload.recording) {
      validateFile(payload.recording, CRM_MAX_ATTACHMENT_BYTES);
      form.append("recording", payload.recording, payload.recording.name);
    }
    const { data } = await API.patch(path, form, mutationOptions);
    return checkedItem<CrmTaskItem>(data);
  },

  async editTaskUpdate(taskId: string, updateId: string, payload: EditTaskUpdatePayload): Promise<CrmTaskItem> {
    const { data } = await API.patch(updatePath(taskId, updateId), payload, mutationOptions);
    return checkedItem<CrmTaskItem>(data);
  },

  async deleteTaskUpdate(taskId: string, updateId: string): Promise<CrmTaskItem> {
    const { data } = await API.delete(updatePath(taskId, updateId), mutationOptions);
    return checkedItem<CrmTaskItem>(data);
  },

  async deleteTaskUpdateAttachments(taskId: string, updateId: string, urls: string[]): Promise<CrmTaskItem> {
    if (!urls.length || urls.some((url) => !safeCrmUrl(url))) throw new Error("Select the attachment to remove.");
    // Explicit URLs prevent an empty selection becoming the backend's remove-all operation.
    const { data } = await API.delete(`${updatePath(taskId, updateId)}/attachments`, {
      ...mutationOptions, data: { urls },
    });
    return checkedItem<CrmTaskItem>(data);
  },

  async deleteTaskUpdateRecording(taskId: string, updateId: string): Promise<CrmTaskItem> {
    const { data } = await API.delete(`${updatePath(taskId, updateId)}/recording`, mutationOptions);
    return checkedItem<CrmTaskItem>(data);
  },

  async transcribeCommentAudio(payload: { audio: File }, options?: CrmReadOptions): Promise<string> {
    validateFile(payload.audio, CRM_MAX_TRANSCRIPTION_BYTES);
    const form = new FormData();
    form.append("audio", payload.audio, payload.audio.name);
    const { data } = await API.post("/crm/tasks/comment/transcribe", form, { ...mutationOptions, signal: options?.signal });
    if (typeof data?.text !== "string") throw new Error("The server did not return a transcription.");
    return data.text.trim();
  },

  async rewriteEmailWithAI(payload: CrmEmailRewritePayload, options?: CrmReadOptions): Promise<{ subject: string; body: string }> {
    const { data } = await API.post("/crm/tasks/email/rewrite", payload, { ...mutationOptions, signal: options?.signal });
    if (typeof data?.body !== "string" || typeof data?.subject !== "string") throw new Error("The server did not return an email draft.");
    return { subject: data.subject.trim(), body: data.body.trim() };
  },

  async listTransferAgents(options?: CrmReadOptions): Promise<CrmTransferAgent[]> {
    const { data } = await API.get("/crm/tasks/transfer/agents", readOptions(options));
    return checkedItems<CrmTransferAgent>(data);
  },

  async requestTaskTransfer(taskId: string, payload: { toUserId: string; note?: string }): Promise<CrmTaskTransferItem> {
    resourceId(payload.toUserId);
    const { data } = await API.post(`${taskPath(taskId)}/transfer`, payload, mutationOptions);
    return checkedItem<CrmTaskTransferItem>(data);
  },

  async getMyTransferRequests(params: { status?: CrmTransferStatus } = {}, options?: CrmReadOptions): Promise<CrmTaskTransferItem[]> {
    const { data } = await API.get("/crm/tasks/transfers/my", { ...readOptions(options), params });
    return checkedItems<CrmTaskTransferItem>(data);
  },

  async respondToTransferRequest(requestId: string, action: "accept" | "reject", options?: CrmReadOptions): Promise<CrmTaskTransferItem> {
    const { data } = await API.patch(`/crm/tasks/transfers/${resourceId(requestId)}`, { action }, { ...mutationOptions, ...(options?.signal ? { signal: options.signal } : {}) });
    return checkedItem<CrmTaskTransferItem>(data);
  },

  async updateCoverage(payload: { crmAddress: string; crmQuadrant: string[]; crmSpecializations: string[] }, options?: CrmReadOptions): Promise<AuthUser> {
    const { data } = await API.put<AuthUser>("/user", payload, { ...mutationOptions, ...(options?.signal ? { signal: options.signal } : {}) });
    if (!data?._id) throw new Error("The server did not return your saved CRM coverage. Refresh to check it.");
    return data;
  },

  getOutlookCalendarStatus(options?: CrmReadOptions) {
    return OutlookService.getStatus(readOptions(options));
  },

  async getOutlookCalendarAuthUrl(options?: CrmReadOptions): Promise<string> {
    const url = safeCrmUrl(await OutlookService.getAuthUrl(readOptions(options)));
    if (!url) throw new Error("The server did not return a valid Outlook connection link.");
    return url;
  },

  disconnectOutlookCalendar() {
    return OutlookService.disconnect(mutationOptions);
  },

  async addTaskToOutlookCalendar(taskId: string): Promise<CrmCalendarSync> {
    const { data, status } = await API.post(`${taskPath(taskId)}/calendar/ms/outlook`, undefined, mutationOptions);
    if (status === 202 || data?.pending !== undefined) {
      if (status !== 202 || data?.pending !== true || data.eventId || data.webLink) {
        throw new Error("Outlook did not confirm the calendar sync. Check your calendar before trying again.");
      }
      return { pending: true, message: text(data.message) || "Outlook sync is pending. Check your calendar later; no completed event is confirmed yet." };
    }
    return calendarEvent(data);
  },

  async addTasksToOutlookCalendarBulk(taskIds: string[]): Promise<CrmBulkCalendarResponse> {
    if (!taskIds.length || taskIds.length > 100) throw new Error("Select between 1 and 100 tasks for the calendar.");
    if (new Set(taskIds).size !== taskIds.length) throw new Error("Select each calendar task only once.");
    taskIds.forEach(resourceId);
    const { data } = await API.post("/crm/tasks/calendar/ms/outlook/bulk", { taskIds }, mutationOptions);
    return checkedCalendarBatch(data, taskIds);
  },
};

export const crmService = CrmService;
export default CrmService;
