/**
 * Publishes CRM reminders through the shared notification channel while preserving a
 * persisted in-app record as the durable source of truth. Push delivery is an optional
 * real-time enhancement, so callers can continue when a device token is stale or the
 * external gateway is unavailable.
 */
import {
  notifyUser,
} from "./notificationService.js";

type CrmPushTarget = {
  userId?: string | null;
  tokens?: string[] | null;
};

type CrmPushPayload = {
  title: string;
  body: string;
  data: Record<string, unknown>;
};

type NewCrmTaskNotificationInput = CrmPushTarget & {
  count: number;
  leadId?: string;
  clientName?: string;
  title?: string;
  reason?: "assignment" | "reassignment" | "transfer";
};

type CrmAdminMessageNotificationInput = CrmPushTarget & {
  leadId: string;
  clientName?: string;
  title?: string;
  comment?: string;
};

type CrmDueNotificationInput = CrmPushTarget & {
  leadId: string;
  clientName?: string;
  title?: string;
  dueDate?: Date | string;
  overdue: boolean;
};

type CrmReminderNotificationInput = CrmPushTarget & {
  overdueCount: number;
  dueSoonCount: number;
  unfinishedCount: number;
};

const CRM_COMMENT_PREVIEW_LIMIT = 120;

function normalizeTokens(tokens?: string[] | null): string[] {
  return Array.from(
    new Set(
      (Array.isArray(tokens) ? tokens : [])
        .map((token) => String(token || "").trim())
        .filter(Boolean)
    )
  );
}

async function resolveTargetTokens(target: CrmPushTarget): Promise<string[]> {
  return normalizeTokens(target.tokens);
}

function buildLeadLabel(clientName?: string, title?: string): string {
  const normalizedClientName = String(clientName || "").trim();
  if (normalizedClientName) return normalizedClientName;

  const normalizedTitle = String(title || "").trim();
  if (normalizedTitle) return normalizedTitle;

  return "your CRM task";
}

function truncateComment(comment?: string): string {
  const normalized = String(comment || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= CRM_COMMENT_PREVIEW_LIMIT) return normalized;
  return `${normalized.slice(0, CRM_COMMENT_PREVIEW_LIMIT - 1)}…`;
}

function formatDueDateLabel(dueDate?: Date | string): string {
  if (!dueDate) return "soon";
  const parsed = new Date(dueDate);
  if (!Number.isFinite(parsed.getTime())) return "soon";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function sendCrmPushNotification(target: CrmPushTarget, payload: CrmPushPayload): Promise<void> {
  const userId = String(target.userId || "").trim();
  if (!userId) return;

  await notifyUser({
    userId,
    tokens: await resolveTargetTokens(target),
    category: "crm",
    type: String(payload.data.type || "crm_notification"),
    title: payload.title,
    body: payload.body,
    data: payload.data,
  });
}

export async function sendCrmNewTaskNotification(input: NewCrmTaskNotificationInput): Promise<void> {
  const safeCount = Math.max(1, Math.floor(Number(input.count) || 1));
  const leadLabel = buildLeadLabel(input.clientName, input.title);
  const reason = input.reason || "assignment";
  const body =
    safeCount === 1
      ? reason === "reassignment"
        ? `${leadLabel} has been reassigned to you in CRM.`
        : reason === "transfer"
          ? `${leadLabel} has been transferred to you in CRM.`
          : `${leadLabel} has been assigned to you in CRM.`
      : `You have ${safeCount} new CRM tasks waiting for follow-up.`;

  await sendCrmPushNotification(input, {
    title: safeCount === 1 ? "New CRM Task" : "New CRM Tasks",
    body,
    data: {
      type: "crm_new_task",
      taskId: input.leadId || undefined,
      leadId: input.leadId || undefined,
      count: safeCount,
      reason,
    },
  });
}

export async function sendCrmAdminMessageNotification(input: CrmAdminMessageNotificationInput): Promise<void> {
  const leadLabel = buildLeadLabel(input.clientName, input.title);
  const preview = truncateComment(input.comment);
  const body = preview
    ? `Admin replied on ${leadLabel}: “${preview}”`
    : `Admin sent a new CRM message about ${leadLabel}.`;

  await sendCrmPushNotification(input, {
    title: "New Admin CRM Message",
    body,
    data: {
      type: "crm_message_from_admin",
      taskId: input.leadId,
      leadId: input.leadId,
    },
  });
}

export async function sendCrmDueNotification(input: CrmDueNotificationInput): Promise<void> {
  const leadLabel = buildLeadLabel(input.clientName, input.title);
  const dueDateLabel = formatDueDateLabel(input.dueDate);

  await sendCrmPushNotification(input, {
    title: input.overdue ? "CRM Task Overdue" : "CRM Task Due Soon",
    body: input.overdue
      ? `${leadLabel} is overdue. Due ${dueDateLabel}.`
      : `${leadLabel} is due ${dueDateLabel}.`,
    data: {
      type: "crm_due",
      taskId: input.leadId,
      leadId: input.leadId,
      overdue: input.overdue,
      dueDate: input.dueDate ? new Date(input.dueDate).toISOString() : undefined,
    },
  });
}

type CrmFollowUpNotificationInput = CrmPushTarget & {
  leadId: string;
  clientName?: string;
  title?: string;
  /** "YYYY-MM-DD", "HH:mm" (optional) and the IANA zone the agent picked them in. */
  followUpDate: string;
  followUpTime?: string;
  timeZone: string;
  /** "upcoming": the 8 a.m. / 1-hour-before reminder; "overdue": the daily morning one. */
  kind: "upcoming" | "overdue";
  /** The follow-up moment (the time, or 00:00 that day), for the wording. */
  followUpAt: Date;
};

/** "Tue, Oct 20" and "3:00 p.m." as the agent's clock shows them (en-CA). */
function formatFollowUpLabels(at: Date, timeZone: string, hasTime: boolean) {
  const date = at.toLocaleDateString("en-CA", { timeZone, weekday: "short", month: "short", day: "numeric" });
  const time = hasTime ? at.toLocaleTimeString("en-CA", { timeZone, hour: "numeric", minute: "2-digit" }) : undefined;
  return { date, time };
}

/**
 * CRM follow-up reminders (owner decision 2026-10-11): one when the follow-up
 * comes up (8 a.m. that day, or 1 hour before its time), then one each
 * morning while it is overdue. Tapping opens the lead (type crm_follow_up).
 */
export async function sendCrmFollowUpNotification(input: CrmFollowUpNotificationInput): Promise<void> {
  const leadLabel = buildLeadLabel(input.clientName, input.title);
  const { date, time } = formatFollowUpLabels(input.followUpAt, input.timeZone, Boolean(input.followUpTime));
  const when = time ? `${date} at ${time}` : date;
  // en-CA times end in "p.m.", so the sentence gets no second period.
  const whenSentence = when.endsWith(".") ? when : `${when}.`;
  const payload =
    input.kind === "overdue"
      ? {
          title: "CRM follow-up overdue",
          body: `${leadLabel} was due ${whenSentence} Update the lead or pick a new date.`,
        }
      : time
        ? { title: "CRM follow-up in 1 hour", body: `${leadLabel} at ${time} today.` }
        : { title: "CRM follow-up today", body: `Follow up with ${leadLabel} today (${date}).` };

  await sendCrmPushNotification(input, {
    ...payload,
    data: {
      type: "crm_follow_up",
      taskId: input.leadId,
      leadId: input.leadId,
      overdue: input.kind === "overdue",
      followUpDate: input.followUpDate,
      followUpTime: input.followUpTime || undefined,
    },
  });
}

export async function sendCrmReminderNotification(input: CrmReminderNotificationInput): Promise<void> {
  const parts: string[] = [];
  if (input.overdueCount > 0) parts.push(`${input.overdueCount} overdue`);
  if (input.dueSoonCount > 0) parts.push(`${input.dueSoonCount} due soon`);

  const body =
    parts.length > 0
      ? `You have ${parts.join(" and ")}. ${input.unfinishedCount} total active CRM tasks.`
      : `You have ${input.unfinishedCount} active CRM tasks.`;

  await sendCrmPushNotification(input, {
    title: input.overdueCount > 0 ? "⚠️ CRM Tasks Need Attention" : "CRM Task Reminder",
    body,
    data: {
      type: "crm_reminder",
      overdueCount: input.overdueCount,
      dueSoonCount: input.dueSoonCount,
      unfinishedCount: input.unfinishedCount,
    },
  });
}
