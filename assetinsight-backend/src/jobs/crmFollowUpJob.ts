/**
 * CRM follow-up job (owner decision 2026-10-11; rules in
 * service/crmFollowUpService.ts). Every CRM_FOLLOW_UP_SWEEP_MINUTES (default 5,
 * so a 1-hour-before reminder is at most a few minutes late):
 *
 *   1. Upcoming reminder: once per follow-up, when its reminder moment comes
 *      (8 a.m. on the day, or 1 hour before its time). A follow-up already
 *      past by then (the job was down) gets no "upcoming" push; the overdue
 *      reminder covers it.
 *   2. Overdue reminder: once each morning, from 8 a.m. in the follow-up's
 *      time zone, starting the day after the follow-up, until the lead is
 *      updated or given a new date (Task Update ends or moves the follow-up).
 *   3. Outlook: brings follow-up events in line (crmFollowUpOutlookService.ts).
 *
 * Every reminder is claimed with a conditional write before it is sent, so two
 * sweeps (or two API instances) never send the same one twice. Only active CRM
 * agents in the lead's own cohort (review/production) are notified.
 */
import CrmLead from "../models/crmLead.model.js";
import User from "../models/user.model.js";
import { CRM_FOLLOW_UP_REMINDER_HOUR, readCrmFollowUpSchedule } from "../service/crmFollowUpService.js";
import { runCrmFollowUpOutlookSync } from "../service/crmFollowUpOutlookService.js";
import { sendCrmFollowUpNotification } from "../service/crmPushService.js";
import { CRM_OPEN_STATUSES } from "../service/crmWorkflowService.js";
import { isReviewAccount } from "../service/reviewAccountPolicy.js";
import { zonedDateString, zonedHour } from "../utils/zonedTime.js";

const LEAD_FIELDS =
  "_id assignedTo status title clientName isReviewData dueDate followUpDate followUpTime followUpTimeZone " +
  "followUpAt followUpRemindAt followUpReminderSentAt followUpOverdueRemindedAt";
/** Leads read per step per sweep; the rest wait for the next sweep. */
const BATCH = 200;

let followUpTimer: NodeJS.Timeout | null = null;
let sweepInProgress = false;

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Active CRM agents among the assignees, by id. */
async function loadRecipients(leads: any[]): Promise<Map<string, any>> {
  const ids = [...new Set(leads.map((lead) => String(lead.assignedTo || "")).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const users = await User.find({ _id: { $in: ids }, role: "user", isCrmAgent: true, isBlocked: { $ne: true } })
    .select("_id expoPushTokens isReviewAccount")
    .lean();
  return new Map(users.map((user: any) => [String(user._id), user]));
}

/** Review accounts only hear about review data; production agents never do. */
const sameCohort = (lead: any, user: any) => isReviewAccount(user) === (lead?.isReviewData === true);

async function notify(lead: any, user: any, kind: "upcoming" | "overdue") {
  const schedule = readCrmFollowUpSchedule(lead);
  if (!schedule) return;
  await sendCrmFollowUpNotification({
    userId: String(user._id),
    tokens: user.expoPushTokens,
    leadId: String(lead._id),
    clientName: lead.clientName,
    title: lead.title,
    followUpDate: schedule.date,
    followUpTime: schedule.time,
    timeZone: schedule.timeZone,
    followUpAt: schedule.followUpAt,
    kind,
  }).catch((error) => console.error("[CRMFollowUpJob] Push failed", String(lead._id), error));
}

async function sendUpcomingReminders(now: Date): Promise<number> {
  const leads = await CrmLead.find({
    followUpRemindAt: { $lte: now },
    followUpReminderSentAt: { $exists: false },
    status: { $in: CRM_OPEN_STATUSES },
  }).select(LEAD_FIELDS).sort({ followUpRemindAt: 1 }).limit(BATCH).lean();
  const recipients = await loadRecipients(leads);
  let sent = 0;
  for (const lead of leads as any[]) {
    // Claim first: only the sweep that flips the flag for this exact reminder sends it.
    const claim = await CrmLead.updateOne(
      { _id: lead._id, followUpRemindAt: lead.followUpRemindAt, followUpReminderSentAt: { $exists: false } },
      { $set: { followUpReminderSentAt: now } }
    );
    if (claim.modifiedCount !== 1) continue;
    const schedule = readCrmFollowUpSchedule(lead);
    const user = recipients.get(String(lead.assignedTo || ""));
    if (!schedule || !user || !sameCohort(lead, user)) continue;
    if (schedule.dueAt.getTime() < now.getTime()) continue; // Already past: the overdue reminder covers it.
    await notify(lead, user, "upcoming");
    sent += 1;
  }
  return sent;
}

async function sendOverdueReminders(now: Date): Promise<number> {
  const leads = await CrmLead.find({
    followUpAt: { $exists: true },
    dueDate: { $lt: now },
    status: { $in: CRM_OPEN_STATUSES },
    // At most one a day: skip anything reminded in the last 20 hours outright.
    $or: [
      { followUpOverdueRemindedAt: { $exists: false } },
      { followUpOverdueRemindedAt: { $lte: new Date(now.getTime() - 20 * 60 * 60 * 1000) } },
    ],
  }).select(LEAD_FIELDS).sort({ dueDate: 1 }).limit(BATCH).lean();
  const recipients = await loadRecipients(leads);
  let sent = 0;
  for (const lead of leads as any[]) {
    const schedule = readCrmFollowUpSchedule(lead);
    if (!schedule) continue;
    const today = zonedDateString(now, schedule.timeZone);
    // Mornings only, from the day after the follow-up.
    if (today <= schedule.date || zonedHour(now, schedule.timeZone) < CRM_FOLLOW_UP_REMINDER_HOUR) continue;
    const last = lead.followUpOverdueRemindedAt ? new Date(lead.followUpOverdueRemindedAt) : undefined;
    if (last && zonedDateString(last, schedule.timeZone) === today) continue;
    const claim = await CrmLead.updateOne(
      last
        ? { _id: lead._id, followUpOverdueRemindedAt: last }
        : { _id: lead._id, followUpOverdueRemindedAt: { $exists: false } },
      { $set: { followUpOverdueRemindedAt: now } }
    );
    if (claim.modifiedCount !== 1) continue;
    const user = recipients.get(String(lead.assignedTo || ""));
    if (!user || !sameCohort(lead, user)) continue;
    await notify(lead, user, "overdue");
    sent += 1;
  }
  return sent;
}

export async function runCrmFollowUpSweep(now: Date = new Date()): Promise<{ upcoming: number; overdue: number; outlook: number }> {
  if (sweepInProgress) return { upcoming: 0, overdue: 0, outlook: 0 };
  sweepInProgress = true;
  try {
    const upcoming = await sendUpcomingReminders(now).catch((error) => {
      console.error("[CRMFollowUpJob] Upcoming reminders failed", error);
      return 0;
    });
    const overdue = await sendOverdueReminders(now).catch((error) => {
      console.error("[CRMFollowUpJob] Overdue reminders failed", error);
      return 0;
    });
    const outlook = await runCrmFollowUpOutlookSync({ now }).catch((error) => {
      console.error("[CRMFollowUpJob] Outlook sync failed", error);
      return 0;
    });
    return { upcoming, overdue, outlook };
  } finally {
    sweepInProgress = false;
  }
}

export function startCrmFollowUpJob(): void {
  if (followUpTimer) return;
  const everyMinutes = Math.max(1, parsePositiveNumber(process.env.CRM_FOLLOW_UP_SWEEP_MINUTES, 5));
  setTimeout(() => {
    runCrmFollowUpSweep().catch((error) => console.error("[CRMFollowUpJob] Initial sweep failed", error));
  }, 15_000).unref?.();
  followUpTimer = setInterval(() => {
    runCrmFollowUpSweep().catch((error) => console.error("[CRMFollowUpJob] Sweep failed", error));
  }, everyMinutes * 60 * 1000);
  followUpTimer.unref?.();
  console.log(`[CRMFollowUpJob] Started (every ${everyMinutes} minutes)`);
}
