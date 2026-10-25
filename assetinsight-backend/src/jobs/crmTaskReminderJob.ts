import CrmLead from "../models/crmLead.model.js";
import User from "../models/user.model.js";
import { sendCrmTaskDigestEmail } from "../service/crmEmailService.js";
import {
  computeNextCrmReminderDate,
  CRM_OPEN_STATUSES,
  normalizeCrmStatusValue,
} from "../service/crmWorkflowService.js";
import { sendCrmDueNotification, sendCrmReminderNotification } from "../service/crmPushService.js";
import { crmLeadCohortFilter } from "../service/reviewAccountPolicy.js";

const ACTIVE_TASK_STATUSES = [...CRM_OPEN_STATUSES, "pending", "in_progress", "no_answer"] as const;

let reminderTimer: NodeJS.Timeout | null = null;
let sweepInProgress = false;

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export async function runCrmTaskReminderSweep(): Promise<void> {
  if (sweepInProgress) {
    console.log("[CRMReminderJob] Previous sweep still running; skipping this cycle");
    return;
  }

  sweepInProgress = true;

  try {
    const now = new Date();
    const digestIntervalMinutes = parsePositiveNumber(process.env.CRM_DIGEST_INTERVAL_MINUTES, 720);
    const digestIntervalMs = digestIntervalMinutes * 60 * 1000;
    const dueSoonHours = parsePositiveNumber(process.env.CRM_DUE_SOON_HOURS, 48);
    const dueSoonCutoff = new Date(now.getTime() + dueSoonHours * 60 * 60 * 1000);

    const crmUsers = await User.find({
      role: "user",
      isCrmAgent: true,
      isBlocked: { $ne: true },
    })
      .select("_id email username crmDigestLastSentAt expoPushTokens isReviewAccount")
      .lean();

    let sentCount = 0;

    for (const user of crmUsers) {
      try {
        const lastSentRaw = (user as any).crmDigestLastSentAt;
        const lastSent = lastSentRaw ? new Date(lastSentRaw) : undefined;

        const baseFilter = {
          assignedTo: (user as any)._id,
          ...crmLeadCohortFilter(user),
          status: { $in: ACTIVE_TASK_STATUSES as unknown as string[] },
        };

        const [unfinishedCount, overdueCount, dueSoonCount, tasks, dueNotificationCandidates] = await Promise.all([
          CrmLead.countDocuments(baseFilter),
          CrmLead.countDocuments({
            ...baseFilter,
            dueDate: { $lt: now },
          }),
          CrmLead.countDocuments({
            ...baseFilter,
            dueDate: { $gte: now, $lte: dueSoonCutoff },
          }),
          CrmLead.find(baseFilter)
            .select("title clientName status dueDate")
            .sort({ dueDate: 1, createdAt: -1 })
            .limit(10)
            .lean(),
          CrmLead.find({
            assignedTo: (user as any)._id,
            ...crmLeadCohortFilter(user),
            dueDate: { $exists: true, $ne: null, $lte: dueSoonCutoff },
            status: { $nin: ["won", "completed"] },
            // A lead with a follow-up date gets the follow-up job's reminders
            // instead (jobs/crmFollowUpJob.ts, 2026-10-11).
            followUpAt: { $exists: false },
          })
            .select("_id title clientName status lostReason dueDate dueSoonPushSentAt overduePushSentAt")
            .sort({ dueDate: 1, createdAt: -1 })
            .lean(),
        ]);

        for (const task of dueNotificationCandidates) {
          const dueDate = task?.dueDate ? new Date(task.dueDate) : undefined;
          if (!dueDate || !Number.isFinite(dueDate.getTime())) {
            continue;
          }

          const isOverdue = dueDate.getTime() < now.getTime();
          const sentAtRaw = isOverdue ? task?.overduePushSentAt : task?.dueSoonPushSentAt;
          const sentAt = sentAtRaw ? new Date(sentAtRaw) : undefined;
          if (sentAt && Number.isFinite(sentAt.getTime())) {
            continue;
          }
          const normalized = normalizeCrmStatusValue(task?.status, task?.lostReason);

          await sendCrmDueNotification({
            userId: String((user as any)._id || ""),
            leadId: String(task?._id || ""),
            clientName: String(task?.clientName || ""),
            title: String(task?.title || ""),
            dueDate,
            overdue: isOverdue,
          }).catch((pushError) => {
            console.error("[CRMReminderJob] Failed to send due push", task?._id, pushError);
          });

          // `$set: { field: undefined }` is dropped by Mongoose, so the old
          // "clear" writes never cleared anything (found 2026-10-11): a
          // rescheduled lead kept its due-soon flag and missed the next due-soon
          // push, and a New Lead past its due date was pushed as overdue every
          // sweep. Fields are now removed with $unset.
          const statusSet = {
            status: normalized.status,
            ...(normalized.lostReason ? { lostReason: normalized.lostReason } : {}),
          };
          const statusUnset = normalized.lostReason ? {} : { lostReason: 1 };
          if (isOverdue) {
            const nextDueDate = computeNextCrmReminderDate(normalized.status, normalized.lostReason, now);
            await CrmLead.updateOne(
              { _id: task?._id },
              nextDueDate
                ? {
                    // Cadence status: the next reminder date, both flags reset.
                    $set: { ...statusSet, dueDate: nextDueDate },
                    $unset: { ...statusUnset, dueSoonPushSentAt: 1, overduePushSentAt: 1 },
                  }
                : {
                    // No cadence (e.g. New Lead): keep the past due date so the
                    // lead stays Overdue in the lists, and push about it once.
                    $set: { ...statusSet, overduePushSentAt: now },
                    ...(Object.keys(statusUnset).length ? { $unset: statusUnset } : {}),
                  }
            );
          } else {
            await CrmLead.updateOne(
              { _id: task?._id },
              {
                $set: { ...statusSet, dueSoonPushSentAt: now },
                ...(Object.keys(statusUnset).length ? { $unset: statusUnset } : {}),
              }
            );
          }
        }

        if (unfinishedCount <= 0) continue;

        const shouldSendDigest =
          !lastSent || !Number.isFinite(lastSent.getTime()) || now.getTime() - lastSent.getTime() >= digestIntervalMs;
        if (!shouldSendDigest) {
          continue;
        }

        if ((user as any).email) {
          await sendCrmTaskDigestEmail(
            {
              email: (user as any).email,
              username: (user as any).username,
            },
            {
              unfinishedCount,
              overdueCount,
              dueSoonCount,
              tasks: (tasks || []).map((task: any) => ({
                title: String(task?.title || "CRM Follow-up"),
                clientName: String(task?.clientName || "Unknown client"),
                status: String(task?.status || "new_lead"),
                dueDate: task?.dueDate,
              })),
            }
          );
        }

        await sendCrmReminderNotification({
          userId: String((user as any)._id || ""),
          overdueCount,
          dueSoonCount,
          unfinishedCount,
        }).catch((pushError) => {
          console.error("[CRMReminderJob] Failed to send digest push", (user as any)?._id, pushError);
        });

        await User.updateOne({ _id: (user as any)._id }, { $set: { crmDigestLastSentAt: now } });
        sentCount += 1;
      } catch (userError) {
        console.error("[CRMReminderJob] Failed for user", (user as any)?._id, userError);
      }
    }

    console.log(`[CRMReminderJob] Sweep complete. Users notified: ${sentCount}/${crmUsers.length}`);
  } catch (error) {
    console.error("[CRMReminderJob] Sweep failed", error);
  } finally {
    sweepInProgress = false;
  }
}

export function startCrmTaskReminderJob(): void {
  if (reminderTimer) return;

  const enabled = parseBooleanFlag(process.env.CRM_REMINDER_JOB_ENABLED, true);
  if (!enabled) {
    console.log("[CRMReminderJob] Disabled by CRM_REMINDER_JOB_ENABLED");
    return;
  }

  const sweepEveryMinutes = Math.max(5, parsePositiveNumber(process.env.CRM_REMINDER_SWEEP_MINUTES, 60));
  const sweepEveryMs = sweepEveryMinutes * 60 * 1000;

  setTimeout(() => {
    runCrmTaskReminderSweep().catch((e) => {
      console.error("[CRMReminderJob] Initial sweep failed", e);
    });
  }, 10_000);

  reminderTimer = setInterval(() => {
    runCrmTaskReminderSweep().catch((e) => {
      console.error("[CRMReminderJob] Scheduled sweep failed", e);
    });
  }, sweepEveryMs);

  if (typeof (reminderTimer as any)?.unref === "function") {
    (reminderTimer as any).unref();
  }

  console.log(`[CRMReminderJob] Started (every ${sweepEveryMinutes} minutes)`);
}
