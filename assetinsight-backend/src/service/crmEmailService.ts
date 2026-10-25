/**
 * Adapts CRM assignment and digest events to the shared transactional email transport.
 * Empty-recipient and empty-work guards are intentional no-ops, allowing batch jobs to
 * process sparse user data without manufacturing failures or sending empty messages.
 */
import { sendEmail } from "../utils/sendVerificationEmail.js";
import {
  getCrmAgentAssignedEmailHtml,
  getCrmTaskAssignedEmailHtml,
  getCrmTaskDigestEmailHtml,
} from "../utils/emailHtml.js";

type CrmEmailUser = {
  email?: string;
  username?: string;
};

type AssignedTaskSummary = {
  title?: string;
  clientName?: string;
  dueDate?: Date | string;
};

type DigestTaskSummary = {
  title: string;
  clientName: string;
  status: string;
  dueDate?: Date | string;
};

type DigestSummary = {
  unfinishedCount: number;
  overdueCount: number;
  dueSoonCount: number;
  tasks: DigestTaskSummary[];
};

function displayName(user: CrmEmailUser): string {
  const username = String(user.username || "").trim();
  if (username) return username;

  const email = String(user.email || "").trim();
  if (email.includes("@")) {
    return email.split("@")[0] || "there";
  }

  return "there";
}

function crmUrl(): string {
  const base = String(process.env.CLIENT_URL || "https://www.assetinsightvaluation.com").replace(/\/+$/, "");
  return `${base}/`;
}

export async function sendCrmAgentAssignedEmail(user: CrmEmailUser): Promise<void> {
  const to = String(user.email || "").trim();
  if (!to) return;

  const html = getCrmAgentAssignedEmailHtml({
    userName: displayName(user),
    crmUrl: crmUrl(),
  });

  await sendEmail(to, "CRM access enabled for your Asset Insight account", html);
}

export async function sendCrmTasksAssignedEmail(
  user: CrmEmailUser,
  tasks: AssignedTaskSummary[]
): Promise<void> {
  const to = String(user.email || "").trim();
  if (!to || tasks.length === 0) return;

  const html = getCrmTaskAssignedEmailHtml({
    userName: displayName(user),
    taskCount: tasks.length,
    crmUrl: crmUrl(),
    tasks: tasks.map((task) => ({
      title: String(task.title || "CRM Follow-up"),
      clientName: String(task.clientName || "Unknown client"),
      dueDate: task.dueDate,
    })),
  });

  const suffix = tasks.length === 1 ? "" : "s";
  await sendEmail(to, `You have ${tasks.length} new CRM task${suffix}`, html);
}

export async function sendCrmTaskDigestEmail(user: CrmEmailUser, summary: DigestSummary): Promise<void> {
  const to = String(user.email || "").trim();
  if (!to || summary.unfinishedCount <= 0) return;

  const safeTasks: DigestTaskSummary[] = (summary.tasks || []).map((task) => ({
    title: String(task.title || "CRM Follow-up"),
    clientName: String(task.clientName || "Unknown client"),
    status: String(task.status || "pending"),
    dueDate: task.dueDate,
  }));

  const html = getCrmTaskDigestEmailHtml({
    userName: displayName(user),
    crmUrl: crmUrl(),
    unfinishedCount: summary.unfinishedCount,
    overdueCount: summary.overdueCount,
    dueSoonCount: summary.dueSoonCount,
    tasks: safeTasks,
  });

  await sendEmail(to, "CRM tasks reminder", html);
}
