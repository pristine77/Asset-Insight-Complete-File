/**
 * Keeps a CRM follow-up's Outlook event in step with the lead (owner decision
 * 2026-10-11: a follow-up date also goes into the agent's Outlook calendar when
 * they have connected Outlook).
 *
 * Setting, moving or clearing a follow-up marks a durable desired revision.
 * The follow-up job and explicit Add to Outlook share atomic operation admission:
 *
 *   - follow-up set, lead open, assignee has Outlook connected: one event,
 *     created once (Graph transactionId guards a retried create) and updated in
 *     place when the date or time changes;
 *   - follow-up cleared, lead won/lost or reassigned: remove the previous event
 *     before creating another. A disconnected old owner must reconnect first;
 *     their known receipt is never discarded because credentials are absent.
 *
 * A date-only follow-up is an all-day event with no Outlook reminder (the app
 * reminds at 8 a.m.); a timed one is a 30-minute event with Outlook's reminder
 * 1 hour before, matching the app. Definitively rejected writes retry with
 * backoff; uncertain outcomes retain the operation and require reconciliation.
 */
import axios from "axios";
import { randomUUID } from "node:crypto";
import CrmLead from "../models/crmLead.model.js";
import User from "../models/user.model.js";
import { readCrmFollowUpSchedule, type CrmFollowUpSchedule } from "./crmFollowUpService.js";
import { getValidMicrosoftAccessTokenForUser, MS_GRAPH_API_BASE } from "./msOutlookCalendarService.js";
import { addCalendarDays } from "../utils/zonedTime.js";

/** Tries per change before the sync is left for the next change (error kept on the lead). */
export const CRM_FOLLOW_UP_OUTLOOK_MAX_ATTEMPTS = 8;
/** Expiry is evidence of interruption, never permission to replay a mutation. */
const CLAIM_LEASE_MS = 10 * 60 * 1000;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const GRAPH_TIMEOUT_MS = 15_000;
const EVENT_MINUTES = 30;

/**
 * Outlook all-day events start at midnight in a Windows-named zone. These are
 * the zones our agents work in; any other zone gets an 8:00–8:30 event at the
 * same local moment instead (built from UTC instants, always correct).
 */
const WINDOWS_TIME_ZONES: Record<string, string> = {
  "America/Regina": "Canada Central Standard Time",
  "America/Swift_Current": "Canada Central Standard Time",
  "America/Winnipeg": "Central Standard Time",
  "America/Chicago": "Central Standard Time",
  "America/Edmonton": "Mountain Standard Time",
  "America/Denver": "Mountain Standard Time",
  "America/Phoenix": "US Mountain Standard Time",
  "America/Vancouver": "Pacific Standard Time",
  "America/Los_Angeles": "Pacific Standard Time",
  "America/Toronto": "Eastern Standard Time",
  "America/New_York": "Eastern Standard Time",
  "America/Halifax": "Atlantic Standard Time",
  "America/St_Johns": "Newfoundland Standard Time",
  UTC: "UTC",
};

const LEAD_FIELDS =
  "assignedTo status title clientName companyName email phoneRaw phoneFormatted latestComment notes companyLocation contactLocation " +
  "isReviewData followUpDate followUpTime followUpTimeZone followUpAt followUpRemindAt followUpOutlook";

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The Graph event body for a lead's follow-up. */
export function buildCrmFollowUpOutlookEvent(lead: any, schedule: CrmFollowUpSchedule) {
  const client = text(lead?.clientName) || text(lead?.title) || "CRM lead";
  const phone = text(lead?.phoneFormatted) || text(lead?.phoneRaw);
  const details = [
    `<p><strong>CRM follow-up:</strong> ${escapeHtml(client)}</p>`,
    text(lead?.companyName) ? `<p><strong>Company:</strong> ${escapeHtml(lead.companyName)}</p>` : "",
    phone ? `<p><strong>Phone:</strong> ${escapeHtml(phone)}</p>` : "",
    text(lead?.email) ? `<p><strong>Email:</strong> ${escapeHtml(lead.email)}</p>` : "",
    text(lead?.latestComment || lead?.notes) ? `<p><strong>Latest note:</strong> ${escapeHtml(lead.latestComment || lead.notes)}</p>` : "",
  ].filter(Boolean).join("");
  const location = text(lead?.companyLocation) || text(lead?.contactLocation);
  const common = {
    subject: `Follow up: ${client}`,
    body: { contentType: "HTML", content: details },
    categories: ["CRM"],
    ...(location ? { location: { displayName: location } } : {}),
  };

  const windowsZone = WINDOWS_TIME_ZONES[schedule.timeZone];
  if (!schedule.time && windowsZone) {
    return {
      ...common,
      isAllDay: true,
      start: { dateTime: `${schedule.date}T00:00:00`, timeZone: windowsZone },
      end: { dateTime: `${addCalendarDays(schedule.date, 1)}T00:00:00`, timeZone: windowsZone },
      isReminderOn: false,
      showAs: "free",
    };
  }
  // Timed follow-up, or a date-only one in a zone without a Windows name (8:00 local).
  const start = schedule.time ? schedule.followUpAt : schedule.remindAt;
  const end = new Date(start.getTime() + EVENT_MINUTES * 60 * 1000);
  return {
    ...common,
    isAllDay: false,
    start: { dateTime: start.toISOString(), timeZone: "UTC" },
    end: { dateTime: end.toISOString(), timeZone: "UTC" },
    isReminderOn: Boolean(schedule.time),
    ...(schedule.time ? { reminderMinutesBeforeStart: 60 } : {}),
  };
}

const graphHeaders = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" });
const isGone = (error: any) => [404, 410].includes(Number(error?.response?.status));

export type CrmFollowUpOutlookSyncResult =
  | { status: "synced"; eventId?: string; userId?: string; webLink?: string }
  | { status: "pending"; message: string }
  | { status: "failed"; error: string }
  | { status: "missing" };

type Operation = {
  id: string;
  kind: "create" | "update" | "delete";
  state: "prepared" | "sending" | "uncertain";
  userId: string;
  eventId?: string;
  transactionId?: string;
  payload?: Record<string, unknown>;
  desired: Record<string, unknown>;
  attemptToken?: string;
  startedAt?: Date;
  attempts?: number;
};

const QUEUED = "Outlook synchronization is queued or already in progress. Your follow-up is saved.";
const UNCERTAIN = "Outlook did not confirm the calendar change. Your follow-up is saved. Check Outlook and contact support before retrying; no duplicate event will be sent automatically.";
const pending = (message = QUEUED): CrmFollowUpOutlookSyncResult => ({ status: "pending", message });

function desiredFilter(lead: any): Record<string, unknown> {
  const outlook = lead.followUpOutlook || {};
  return {
    crmDeletionToken: { $exists: false },
    assignedTo: lead.assignedTo,
    status: lead.status,
    followUpDate: lead.followUpDate ?? { $exists: false },
    followUpTime: lead.followUpTime ?? { $exists: false },
    followUpTimeZone: lead.followUpTimeZone ?? { $exists: false },
    "followUpOutlook.version": outlook.version ?? { $exists: false },
    "followUpOutlook.changeId": outlook.changeId ?? { $exists: false },
  };
}

const operationFilter = (leadId: string, operation: Operation) => ({
  _id: leadId,
  "followUpOutlookOperation.id": operation.id,
  "followUpOutlookOperation.attemptToken": operation.attemptToken,
});

/** A receipt and its retirement are one database write, not separate unfenced writes. */
async function confirmOperation(leadId: string, operation: Operation, now: Date, eventId?: string): Promise<void> {
  const set: Record<string, unknown> = {
    "followUpOutlook.attempts": 0,
    ...(eventId ? { "followUpOutlook.eventId": eventId, "followUpOutlook.userId": operation.userId } : {}),
  };
  const unset: Record<string, 1> = {
    "followUpOutlookOperation": 1,
    "followUpOutlook.lastError": 1,
    ...(!eventId ? { "followUpOutlook.eventId": 1, "followUpOutlook.userId": 1 } as const : {}),
  };
  // Only a create/update for the still-current intent can finish the sync. A
  // delete or a stale success first records its receipt, then re-reads the lead.
  if (eventId) {
    const complete = await CrmLead.updateOne(
      { ...operationFilter(leadId, operation), ...operation.desired },
      { $set: { ...set, "followUpOutlook.syncPending": false, "followUpOutlook.syncedAt": now },
        $unset: { ...unset, "followUpOutlook.nextAttemptAt": 1 } }
    );
    if (complete.modifiedCount === 1) return;
  }
  await CrmLead.updateOne(operationFilter(leadId, operation), {
    $set: { ...set, "followUpOutlook.syncPending": true, "followUpOutlook.nextAttemptAt": now },
    $unset: unset,
  });
}

async function markUncertain(leadId: string, operation: Operation): Promise<void> {
  await CrmLead.updateOne(operationFilter(leadId, operation), {
    $set: { "followUpOutlookOperation.state": "uncertain", "followUpOutlook.syncPending": true,
      "followUpOutlook.lastError": UNCERTAIN },
    $unset: { "followUpOutlook.nextAttemptAt": 1 },
  });
}

/**
 * Manual requests and sweeps share the same durable operation admission. A
 * sending operation is never reclaimed for a second mutation after lease expiry:
 * timeout/process loss cannot prove that Microsoft did not apply it. Its original
 * receipt may still arrive and is accepted only for that exact operation/attempt.
 */
export async function syncCrmFollowUpOutlookEvent(leadId: string, now: Date = new Date()): Promise<CrmFollowUpOutlookSyncResult> {
  let receipt: { eventId: string; userId: string; webLink?: string } | undefined;
  for (let step = 0; step < 6; step += 1) {
    const lead = await CrmLead.findById(leadId).select(LEAD_FIELDS).select("+followUpOutlookOperation").lean() as any;
    if (!lead) return { status: "missing" };
    const outlook = lead.followUpOutlook || {};
    let operation: Operation | undefined = lead.followUpOutlookOperation;
    if (operation?.state === "sending" || operation?.state === "uncertain") {
      if (operation.state === "uncertain" || !operation.startedAt || now.getTime() - new Date(operation.startedAt).getTime() >= CLAIM_LEASE_MS) {
        await markUncertain(leadId, operation);
        return pending(UNCERTAIN);
      }
      return pending();
    }
    if (!operation && outlook.syncPending === false) {
      const eventId = text(outlook.eventId) || undefined;
      const webLink = receipt?.eventId === eventId && receipt?.userId === String(outlook.userId)
        ? receipt.webLink : undefined;
      return { status: "synced", eventId, userId: eventId ? String(outlook.userId) : undefined, webLink };
    }
    if (outlook.nextAttemptAt && new Date(outlook.nextAttemptAt).getTime() > now.getTime()) return pending();

    if (!operation) {
      const assigneeId = lead.assignedTo ? String(lead.assignedTo) : "";
      const assignee = assigneeId
        ? await User.findById(assigneeId).select("msOutlookCalendarConnected isBlocked isCrmAgent isReviewAccount").lean() as any
        : null;
      const sameCohort = Boolean(assignee?.isReviewAccount) === Boolean(lead.isReviewData);
      const schedule = readCrmFollowUpSchedule(lead);
      const wantEvent = Boolean(schedule && !["won", "lost"].includes(lead.status) && assignee?.msOutlookCalendarConnected &&
        assignee?.isCrmAgent && !assignee?.isBlocked && sameCohort);
      const eventId = text(outlook.eventId);
      const eventUserId = outlook.userId ? String(outlook.userId) : "";
      const desired = desiredFilter(lead);
      if (!eventId && !wantEvent) {
        const done = await CrmLead.updateOne({ _id: leadId, ...desired, "followUpOutlookOperation": { $exists: false } }, {
          $set: { "followUpOutlook.syncPending": false, "followUpOutlook.attempts": 0, "followUpOutlook.syncedAt": now },
          $unset: { "followUpOutlook.lastError": 1, "followUpOutlook.nextAttemptAt": 1 },
        });
        if (done.modifiedCount) return { status: "synced" };
        continue;
      }
      if (eventId && !eventUserId) return { status: "failed", error: "The existing Outlook event owner is missing. Contact support; the event was retained." };
      const kind = eventId && (!wantEvent || eventUserId !== assigneeId) ? "delete" : eventId ? "update" : "create";
      const id = randomUUID();
      operation = {
        id, kind, state: "prepared", desired,
        userId: kind === "delete" ? eventUserId : assigneeId,
        ...(eventId ? { eventId } : {}),
        ...(kind === "create" ? { transactionId: `crm-follow-up-${leadId}-${id}` } : {}),
        ...(kind !== "delete" ? { payload: buildCrmFollowUpOutlookEvent(lead, schedule!) } : {}),
        attempts: 0,
      };
      const prepared = await CrmLead.updateOne({ _id: leadId, ...desired, "followUpOutlookOperation": { $exists: false } }, {
        $set: { "followUpOutlookOperation": operation, "followUpOutlook.syncPending": true },
      });
      if (!prepared.modifiedCount) continue;
    }

    // Prepared means no provider write is in flight. A newer intent may retire
    // it, but never a sending/uncertain operation with a possible remote effect.
    if (!await CrmLead.exists({ _id: leadId, ...operation.desired })) {
      await CrmLead.updateOne({ _id: leadId, "followUpOutlookOperation.id": operation.id, "followUpOutlookOperation.state": "prepared" },
        { $unset: { "followUpOutlookOperation": 1 } });
      continue;
    }
    if (Number(operation.attempts || 0) >= CRM_FOLLOW_UP_OUTLOOK_MAX_ATTEMPTS) {
      return { status: "failed", error: "Outlook synchronization needs attention. Your follow-up and pending operation are saved." };
    }
    // A disconnected previous owner must not cause us to forget their known
    // event and create a duplicate in a new owner's calendar.
    const owner = await User.findById(operation.userId).select("msOutlookCalendarConnected isBlocked isCrmAgent isReviewAccount").lean() as any;
    if (!owner?.msOutlookCalendarConnected || owner?.isBlocked || !owner?.isCrmAgent ||
        Boolean(owner?.isReviewAccount) !== Boolean(lead.isReviewData)) {
      return { status: "failed", error: "Reconnect the original Outlook account to finish this calendar change. The existing event and pending operation were retained." };
    }
    let accessToken: string;
    try { accessToken = await getValidMicrosoftAccessTokenForUser(String(operation.userId)); }
    catch { return { status: "failed", error: "Reconnect Outlook to finish this calendar change. Your follow-up is saved." }; }
    // Token refresh can take time. A disconnect/revocation while it ran must
    // not admit a new provider mutation using the just-returned credentials.
    if (!await User.exists({ _id: operation.userId, msOutlookCalendarConnected: true, isBlocked: { $ne: true },
      isCrmAgent: true, isReviewAccount: lead.isReviewData ? true : { $ne: true } })) {
      return { status: "failed", error: "Outlook access changed. The follow-up and pending calendar change were retained." };
    }
    const attemptToken = randomUUID();
    const claimed = await CrmLead.updateOne({ _id: leadId, ...operation.desired, "followUpOutlookOperation.id": operation.id, "followUpOutlookOperation.state": "prepared" }, {
      $set: { "followUpOutlookOperation.state": "sending", "followUpOutlookOperation.attemptToken": attemptToken,
        "followUpOutlookOperation.startedAt": now, "followUpOutlook.nextAttemptAt": new Date(now.getTime() + CLAIM_LEASE_MS) },
      $inc: { "followUpOutlookOperation.attempts": 1 },
    });
    if (!claimed.modifiedCount) return pending();
    operation = { ...operation, state: "sending", attemptToken, attempts: Number(operation.attempts || 0) + 1 };
    const options = { headers: graphHeaders(accessToken), timeout: GRAPH_TIMEOUT_MS };
    try {
      if (operation.kind === "delete") {
        const response = await axios.delete(`${MS_GRAPH_API_BASE}/me/events/${encodeURIComponent(operation.eventId!)}`, options);
        if (response.status !== 204) { await markUncertain(leadId, operation); return pending(UNCERTAIN); }
        await confirmOperation(leadId, operation, now);
      } else {
        const response = operation.kind === "create"
          ? await axios.post(`${MS_GRAPH_API_BASE}/me/events`, { ...operation.payload, transactionId: operation.transactionId }, options)
          : await axios.patch(`${MS_GRAPH_API_BASE}/me/events/${encodeURIComponent(operation.eventId!)}`, operation.payload, options);
        const eventId = text(response.data?.id);
        if (!eventId || (operation.kind === "update" && eventId !== operation.eventId)) {
          await markUncertain(leadId, operation);
          return pending(UNCERTAIN);
        }
        receipt = { eventId, userId: String(operation.userId), webLink: text(response.data?.webLink) || undefined };
        await confirmOperation(leadId, operation, now, eventId);
      }
    } catch (error: any) {
      if (operation.kind !== "create" && isGone(error)) {
        await confirmOperation(leadId, operation, now);
        continue;
      }
      // A transport error, 5xx or invalid receipt may have applied the write.
      // Do not replay it or permit a newer operation to overtake it. Known
      // admission/rate rejections can retry the exact immutable operation.
      const status = Number(error?.response?.status);
      const rejected = [400, 401, 403, 404, 405, 422, 429].includes(status);
      console.error("[CRMFollowUpOutlook] Sync not confirmed", leadId, { status: Number.isFinite(status) ? status : undefined });
      if (!rejected) { await markUncertain(leadId, operation); return pending(UNCERTAIN); }
      const attempts = Number(operation.attempts);
      const message = status === 429 ? "Outlook is busy. The same calendar change will retry later." : "Outlook rejected the calendar change. Check the Outlook connection and follow-up details.";
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
      await CrmLead.updateOne(operationFilter(leadId, operation), {
        $set: { "followUpOutlookOperation.state": "prepared", "followUpOutlook.attempts": attempts,
          "followUpOutlook.lastError": message, "followUpOutlook.syncPending": true,
          ...(attempts < CRM_FOLLOW_UP_OUTLOOK_MAX_ATTEMPTS ? { "followUpOutlook.nextAttemptAt": new Date(now.getTime() + delay) } : {}) },
        ...(attempts >= CRM_FOLLOW_UP_OUTLOOK_MAX_ATTEMPTS ? { $unset: { "followUpOutlook.nextAttemptAt": 1 } } : {}),
      });
      return { status: "failed", error: message };
    }
  }
  return pending();
}

/** Bounded sweep; the service, not this caller, owns all mutation admission. */
export async function runCrmFollowUpOutlookSync(options: { now?: Date; limit?: number } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 25;
  await CrmLead.updateMany(
    {
      "followUpOutlook.eventId": { $exists: true },
      "followUpOutlook.syncPending": { $ne: true },
      $expr: { $ne: ["$followUpOutlook.userId", "$assignedTo"] },
    },
    {
      $set: { "followUpOutlook.syncPending": true, "followUpOutlook.attempts": 0, "followUpOutlook.nextAttemptAt": now },
      $inc: { "followUpOutlook.version": 1 },
    }
  );

  const leads = await CrmLead.find({ "followUpOutlook.syncPending": true, "followUpOutlook.nextAttemptAt": { $lte: now } })
    .select("_id").sort({ "followUpOutlook.nextAttemptAt": 1 }).limit(limit).lean();
  for (const lead of leads) await syncCrmFollowUpOutlookEvent(String(lead._id), now);
  return leads.length;
}
