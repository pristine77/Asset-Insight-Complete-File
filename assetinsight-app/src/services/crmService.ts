import api from "./api";
import { API_ENDPOINTS } from "../config/api";

export const CRM_STATUSES = [
  "new_lead",
  "contacted",
  "inspection_required",
  "inspection_complete",
  "proposal_submitted",
  "decision_pending",
  "won",
  "lost",
] as const;

export type CrmTaskStatus = (typeof CRM_STATUSES)[number];
export const CRM_LOST_REASONS = ["not_interested", "timing", "competitor", "no_assets"] as const;
export type CrmLostReason = (typeof CRM_LOST_REASONS)[number];
export type CrmTaskFilterStatus = CrmTaskStatus | "archived" | "all";

export const CRM_OPEN_STATUSES: CrmTaskStatus[] = [
  "new_lead",
  "contacted",
  "inspection_required",
  "inspection_complete",
  "proposal_submitted",
  "decision_pending",
];

export const CRM_STATUS_LABELS: Record<CrmTaskStatus, string> = {
  new_lead: "New Lead",
  contacted: "Contacted",
  inspection_required: "Inspection Required",
  inspection_complete: "Inspection Complete",
  proposal_submitted: "Proposal Submitted",
  decision_pending: "Decision Pending",
  won: "Won",
  lost: "Lost",
};

export const CRM_SPECIALIZATION_OPTIONS = [
  { value: "industrial_construction", label: "Industrial & Construction" },
  { value: "farm_equipment_sales", label: "Farm & Farm Equipment Sales" },
  { value: "others", label: "Others" },
] as const;

export type CrmSpecializationValue = (typeof CRM_SPECIALIZATION_OPTIONS)[number]["value"];

export const CRM_LOST_REASON_LABELS: Record<CrmLostReason, string> = {
  not_interested: "Not Interested",
  timing: "Timing",
  competitor: "Competitor",
  no_assets: "No Assets",
};

export interface UploadableFile {
  uri: string;
  name: string;
  type: string;
}

export interface CrmTaskUpdateEntry {
  _id?: string;
  comment?: string;
  status: CrmTaskStatus;
  lostReason?: CrmLostReason;
  reminderDate?: string;
  attachmentUrls?: string[];
  recordingUrl?: string;
  createdBy?: { _id?: string; email?: string; username?: string; role?: string };
  createdAt: string;
  editedAt?: string;
  isDeleted?: boolean;
  deletedAt?: string;
}

export interface CrmTaskItem {
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
  leadSource?: "generic" | "organic";
  status: CrmTaskStatus;
  lostReason?: CrmLostReason;
  priority?: "low" | "medium" | "high";
  callAttempts?: number;
  lastCalledAt?: string;
  statusChangedAt?: string;
  taskStartDate?: string;
  dueDate?: string;
  /** Follow-up date the agent picked (2026-10-11): "YYYY-MM-DD" in followUpTimeZone. */
  followUpDate?: string;
  /** "HH:mm", absent for a date-only follow-up. */
  followUpTime?: string;
  followUpTimeZone?: string;
  /** The follow-up moment: its time, or 00:00 that day (ISO). */
  followUpAt?: string;
  /** When the reminder comes: 8 a.m. that day, or 1 hour before its time (ISO). */
  followUpRemindAt?: string;
  /** Set once the server has sent that reminder (ISO). */
  followUpReminderSentAt?: string;
  latestComment?: string;
  latestAttachmentUrls?: string[];
  latestRecordingUrl?: string;
  assignedBy?: { _id?: string; email?: string; username?: string };
  updates?: CrmTaskUpdateEntry[];
  createdAt: string;
  updatedAt: string;
}

/** GET /crm/tasks/follow-ups: the follow-up calendar for a date range. */
export interface CrmFollowUpCalendar {
  asOf: string;
  from: string;
  to: string;
  timeZone: string;
  /** Open leads with a follow-up in the range, by follow-up time. */
  items: CrmTaskItem[];
  /** Every follow-up that has already passed, oldest first. */
  overdue: CrmTaskItem[];
}

export interface CrmTasksResponse {
  items: CrmTaskItem[];
  total: number;
  page: number;
  limit: number;
  statusCounts?: Array<{
    _id?: CrmTaskStatus | string;
    status?: CrmTaskStatus | string;
    count?: number;
  }>;
  leadSourceCounts?: {
    total: number;
    generic: number;
    organic: number;
  };
}

export type CrmTransferStatus = "pending" | "accepted" | "rejected" | "cancelled";

export interface CrmTransferAgent {
  _id: string;
  email?: string;
  username?: string;
  crmAddress?: string;
  crmQuadrant?: string;
  crmSpecializations?: string[];
}

export interface CrmTaskTransferItem {
  _id: string;
  leadId?: {
    _id?: string;
    clientName?: string;
    title?: string;
    status?: CrmTaskStatus;
    dueDate?: string;
  };
  fromUserId?: {
    _id?: string;
    email?: string;
    username?: string;
  };
  toUserId?: {
    _id?: string;
    email?: string;
    username?: string;
  };
  requestedBy?: string;
  status: CrmTransferStatus;
  note?: string;
  respondedAt?: string;
  respondedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CrmOutlookCalendarStatus {
  connected: boolean;
  email?: string;
  connectedAt?: string | null;
  configured?: boolean;
}

export type CrmLeadSourceFilter = "generic" | "organic";
export type CrmDueFilter = "upcoming" | "overdue";
export type CrmDashboardTaskFilter = "all" | CrmLeadSourceFilter | CrmDueFilter;

interface GetMyTasksParams {
  q?: string;
  status?: CrmTaskFilterStatus;
  leadSource?: CrmLeadSourceFilter;
  due?: CrmDueFilter;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

interface SubmitTaskUpdatePayload {
  comment?: string;
  status?: CrmTaskStatus;
  lostReason?: CrmLostReason;
  attachments?: UploadableFile[];
  recording?: UploadableFile | null;
  /**
   * Follow-up date (2026-10-11). Set: date "YYYY-MM-DD", optional time "HH:mm"
   * and the phone's zone. Clear: removes it. Leave out to keep the current one.
   */
  followUp?: { date: string; time?: string; timeZone: string } | 'clear';
}

interface QuickAddLeadPayload {
  name: string;
  phone: string;
  notes?: string;
  specialization: CrmSpecializationValue | string;
  category?: string;
  dueDate?: string;
}

interface TranscribeCommentAudioPayload {
  audio: UploadableFile;
}

interface EditTaskUpdatePayload {
  comment?: string;
  status?: CrmTaskStatus;
  lostReason?: CrmLostReason;
}

class CrmService {
  async getMyTasks(params: GetMyTasksParams = {}): Promise<CrmTasksResponse> {
    const query = new URLSearchParams();
    if (params.q) query.set("q", params.q);
    if (params.status) query.set("status", params.status);
    if (params.leadSource) query.set("leadSource", params.leadSource);
    if (params.due) query.set("due", params.due);
    if (params.from) query.set("from", params.from);
    if (params.to) query.set("to", params.to);
    if (params.page) query.set("page", String(params.page));
    if (params.limit) query.set("limit", String(params.limit));

    const suffix = query.toString() ? `?${query.toString()}` : "";
    const { data } = await api.get(`${API_ENDPOINTS.CRM_MY_TASKS}${suffix}`);

    const items = Array.isArray(data?.items) ? data.items : [];
    const fallbackOrganic = items.filter((item: CrmTaskItem) => {
      const source = String(item?.leadSource || "").toLowerCase();
      const title = String(item?.title || "");
      return source === "organic" || /^quick add/i.test(title);
    }).length;
    const fallbackGeneric = Math.max(items.length - fallbackOrganic, 0);
    const rawCounts = data?.leadSourceCounts;
    const rawOrganic = Number(rawCounts?.organic || 0);
    const shouldUseFallbackCounts = !rawCounts || (rawOrganic === 0 && fallbackOrganic > 0);

    return {
      items,
      total: Number(data?.total || 0),
      page: Number(data?.page || 1),
      limit: Number(data?.limit || params.limit || 20),
      statusCounts: Array.isArray(data?.statusCounts) ? data.statusCounts : [],
      leadSourceCounts: {
        total: Number(
          shouldUseFallbackCounts ? data?.total || items.length : rawCounts?.total || data?.total || 0
        ),
        generic: Number(shouldUseFallbackCounts ? fallbackGeneric : rawCounts?.generic || 0),
        organic: Number(shouldUseFallbackCounts ? fallbackOrganic : rawOrganic),
      },
    };
  }

  /** One assigned task (without its history), for opening a lead that is not in the loaded list. */
  async getTask(taskId: string): Promise<CrmTaskItem> {
    const { data } = await api.get(`${API_ENDPOINTS.CRM_TASKS}/${encodeURIComponent(taskId)}`);
    return data?.item as CrmTaskItem;
  }

  /** Follow-ups from `from` to `to` ("YYYY-MM-DD", at most 62 days) in the phone's zone, plus every passed one. */
  async getFollowUps(params: { from: string; to: string; timeZone: string }): Promise<CrmFollowUpCalendar> {
    const query = (["from", "to", "timeZone"] as const)
      .map((key) => `${key}=${encodeURIComponent(params[key])}`)
      .join("&");
    const { data } = await api.get(`${API_ENDPOINTS.CRM_FOLLOW_UPS}?${query}`);
    return {
      asOf: String(data?.asOf || ""),
      from: String(data?.from || params.from),
      to: String(data?.to || params.to),
      timeZone: String(data?.timeZone || params.timeZone),
      items: Array.isArray(data?.items) ? data.items : [],
      overdue: Array.isArray(data?.overdue) ? data.overdue : [],
    };
  }

  async quickAddLead(payload: QuickAddLeadPayload): Promise<CrmTaskItem> {
    const { data } = await api.post(API_ENDPOINTS.CRM_TASKS_QUICK_ADD, payload);
    return data?.item as CrmTaskItem;
  }

  async submitTaskUpdate(taskId: string, payload: SubmitTaskUpdatePayload): Promise<CrmTaskItem> {
    const formData = new FormData();
    if (payload.comment?.trim()) {
      formData.append("comment", payload.comment.trim());
    }
    if (payload.status) {
      formData.append("status", payload.status);
    }
    if (payload.lostReason) formData.append("lostReason", payload.lostReason);
    if (payload.followUp === "clear") {
      formData.append("clearFollowUp", "true");
    } else if (payload.followUp) {
      formData.append("followUpDate", payload.followUp.date);
      if (payload.followUp.time) formData.append("followUpTime", payload.followUp.time);
      formData.append("followUpTimeZone", payload.followUp.timeZone);
    }

    for (const file of payload.attachments || []) {
      formData.append(
        "attachments",
        {
          uri: file.uri,
          name: file.name,
          type: file.type,
        } as unknown as Blob
      );
    }

    if (payload.recording?.uri) {
      formData.append(
        "recording",
        {
          uri: payload.recording.uri,
          name: payload.recording.name,
          type: payload.recording.type,
        } as unknown as Blob
      );
    }

    const { data } = await api.patch(
      `${API_ENDPOINTS.CRM_TASKS}/${taskId}/update`,
      formData,
      {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      }
    );

    return data?.item as CrmTaskItem;
  }

  async transcribeCommentAudio(payload: TranscribeCommentAudioPayload): Promise<string> {
    const formData = new FormData();
    formData.append(
      "audio",
      {
        uri: payload.audio.uri,
        name: payload.audio.name,
        type: payload.audio.type,
      } as unknown as Blob
    );

    const { data } = await api.post(API_ENDPOINTS.CRM_TASK_COMMENT_TRANSCRIBE, formData, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
    });

    return String(data?.text || "").trim();
  }

  async editTaskUpdate(taskId: string, updateId: string, payload: EditTaskUpdatePayload): Promise<CrmTaskItem> {
    const safeTaskId = encodeURIComponent(taskId);
    const safeUpdateId = encodeURIComponent(updateId);
    const { data } = await api.patch(
      `${API_ENDPOINTS.CRM_TASKS}/${safeTaskId}/updates/${safeUpdateId}`,
      payload
    );
    return data?.item as CrmTaskItem;
  }

  async deleteTaskUpdate(taskId: string, updateId: string): Promise<CrmTaskItem> {
    const safeTaskId = encodeURIComponent(taskId);
    const safeUpdateId = encodeURIComponent(updateId);
    const { data } = await api.delete(
      `${API_ENDPOINTS.CRM_TASKS}/${safeTaskId}/updates/${safeUpdateId}`
    );
    return data?.item as CrmTaskItem;
  }

  async deleteTaskUpdateAttachments(taskId: string, updateId: string, urls?: string[]): Promise<CrmTaskItem> {
    const safeTaskId = encodeURIComponent(taskId);
    const safeUpdateId = encodeURIComponent(updateId);
    const payload = Array.isArray(urls) && urls.length > 0 ? { urls } : undefined;
    const { data } = await api.delete(
      `${API_ENDPOINTS.CRM_TASKS}/${safeTaskId}/updates/${safeUpdateId}/attachments`,
      payload ? { data: payload } : undefined
    );
    return data?.item as CrmTaskItem;
  }

  async deleteTaskUpdateRecording(taskId: string, updateId: string): Promise<CrmTaskItem> {
    const safeTaskId = encodeURIComponent(taskId);
    const safeUpdateId = encodeURIComponent(updateId);
    const { data } = await api.delete(
      `${API_ENDPOINTS.CRM_TASKS}/${safeTaskId}/updates/${safeUpdateId}/recording`
    );
    return data?.item as CrmTaskItem;
  }

  async rewriteEmailWithAI(payload: {
    body: string;
    subject?: string;
    clientName?: string;
    senderName?: string;
    senderCompany?: string;
  }): Promise<{ subject: string; body: string }> {
    const { data } = await api.post(API_ENDPOINTS.CRM_EMAIL_REWRITE, payload);
    return {
      subject: String(data?.subject || payload.subject || "").trim(),
      body: String(data?.body || payload.body || "").trim(),
    };
  }

  async getOutlookCalendarStatus(): Promise<CrmOutlookCalendarStatus> {
    const { data } = await api.get(API_ENDPOINTS.CRM_OUTLOOK_STATUS);
    return {
      connected: Boolean(data?.connected),
      email: String(data?.email || "").trim() || undefined,
      connectedAt: data?.connectedAt || null,
      configured: data?.configured !== false,
    };
  }

  async getOutlookCalendarAuthUrl(): Promise<string> {
    const { data } = await api.get(API_ENDPOINTS.CRM_OUTLOOK_AUTH_URL);
    return String(data?.authUrl || "").trim();
  }

  async disconnectOutlookCalendar(): Promise<void> {
    await api.delete(API_ENDPOINTS.CRM_OUTLOOK_DISCONNECT);
  }

  async addTaskToOutlookCalendar(taskId: string): Promise<{ eventId?: string; webLink?: string; pending: boolean; message?: string }> {
    const safeTaskId = encodeURIComponent(taskId);
    const { data } = await api.post(`${API_ENDPOINTS.CRM_TASKS}/${safeTaskId}/calendar/ms/outlook`);
    return {
      pending: data?.pending === true,
      message: String(data?.message || '').trim() || undefined,
      eventId: String(data?.eventId || "").trim() || undefined,
      webLink: String(data?.webLink || "").trim() || undefined,
    };
  }

  async addTasksToOutlookCalendarBulk(taskIds: string[]): Promise<{
    createdCount: number;
    failedCount: number;
    pendingCount: number;
    created: { taskId: string; eventId?: string; webLink?: string }[];
    failed: { taskId: string; reason: string }[];
    pending: { taskId: string; reason: string }[];
  }> {
    const { data } = await api.post(API_ENDPOINTS.CRM_OUTLOOK_BULK_ADD, { taskIds });
    return {
      createdCount: Number(data?.createdCount || 0),
      failedCount: Number(data?.failedCount || 0),
      pendingCount: Number(data?.pendingCount || 0),
      created: Array.isArray(data?.created) ? data.created : [],
      failed: Array.isArray(data?.failed) ? data.failed : [],
      pending: Array.isArray(data?.pending) ? data.pending : [],
    };
  }

  async listTransferAgents(): Promise<CrmTransferAgent[]> {
    const { data } = await api.get(API_ENDPOINTS.CRM_TRANSFER_AGENTS);
    return Array.isArray(data?.items) ? (data.items as CrmTransferAgent[]) : [];
  }

  async requestTaskTransfer(taskId: string, payload: { toUserId: string; note?: string }) {
    const safeTaskId = encodeURIComponent(taskId);
    const { data } = await api.post(`${API_ENDPOINTS.CRM_TASKS}/${safeTaskId}/transfer`, payload);
    return data?.item as CrmTaskTransferItem;
  }

  async getMyTransferRequests(params: { status?: CrmTransferStatus } = {}): Promise<CrmTaskTransferItem[]> {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const { data } = await api.get(`${API_ENDPOINTS.CRM_TRANSFER_INBOX}${suffix}`);
    return Array.isArray(data?.items) ? (data.items as CrmTaskTransferItem[]) : [];
  }

  async respondToTransferRequest(requestId: string, action: "accept" | "reject") {
    const safeRequestId = encodeURIComponent(requestId);
    const { data } = await api.patch(`${API_ENDPOINTS.CRM_TASKS}/transfers/${safeRequestId}`, { action });
    return data?.item as CrmTaskTransferItem;
  }
}

export const crmService = new CrmService();
export default crmService;
