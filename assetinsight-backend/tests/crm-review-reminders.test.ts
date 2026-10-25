import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  users: [] as any[],
  leads: [] as any[],
  userSelect: vi.fn(),
  userUpdate: vi.fn(),
  count: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  email: vi.fn(),
  due: vi.fn(),
  reminder: vi.fn(),
}));

vi.mock("../src/models/user.model.js", () => ({ default: {
  find: () => ({ select: (fields: string) => {
    fixtures.userSelect(fields);
    return { lean: async () => fixtures.users };
  } }),
  updateOne: fixtures.userUpdate,
} }));
vi.mock("../src/models/crmLead.model.js", () => ({
  CRM_LEAD_STATUSES: ["new_lead", "contacted", "inspection_required", "inspection_complete", "proposal_submitted", "decision_pending", "won", "lost"],
  CRM_LOST_REASONS: [],
  default: {
    countDocuments: fixtures.count,
    find: fixtures.find,
    updateOne: fixtures.update,
  },
}));
vi.mock("../src/service/crmEmailService.js", () => ({ sendCrmTaskDigestEmail: fixtures.email }));
vi.mock("../src/service/crmPushService.js", () => ({
  sendCrmDueNotification: fixtures.due,
  sendCrmReminderNotification: fixtures.reminder,
}));

import { runCrmTaskReminderSweep } from "../src/jobs/crmTaskReminderJob.js";

function matches(lead: any, filter: any) {
  if (lead.assignedTo !== filter.assignedTo) return false;
  if (filter.isReviewData === true && lead.isReviewData !== true) return false;
  if (filter.isReviewData?.$ne === true && lead.isReviewData === true) return false;
  if (filter.dueDate?.$lt && lead.dueDate >= filter.dueDate.$lt) return false;
  return true;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.users = [];
  fixtures.leads = [];
  for (const mock of [fixtures.userUpdate, fixtures.update, fixtures.email, fixtures.due, fixtures.reminder]) {
    mock.mockResolvedValue({});
  }
  fixtures.count.mockImplementation(async (filter) => fixtures.leads.filter((lead) => matches(lead, filter)).length);
  fixtures.find.mockImplementation((filter) => {
    const query = {
      select: () => query,
      sort: () => query,
      limit: () => query,
      lean: async () => fixtures.leads.filter((lead) => matches(lead, filter)),
    };
    return query;
  });
});

describe("CRM reminder account/data cohort isolation", () => {
  it.each([undefined, false, true])("scopes all reads to the current account cohort (review=%s)", async (isReviewAccount) => {
    fixtures.users = [{ _id: "agent", email: "agent@example.test", isReviewAccount }];
    await runCrmTaskReminderSweep();
    expect(fixtures.userSelect).toHaveBeenCalledWith(expect.stringContaining("isReviewAccount"));
    const isReviewData = isReviewAccount === true ? true : { $ne: true };
    expect(fixtures.count).toHaveBeenCalledTimes(3);
    expect(fixtures.find).toHaveBeenCalledTimes(2);
    for (const [filter] of [...fixtures.count.mock.calls, ...fixtures.find.mock.calls]) {
      expect(filter).toMatchObject({ assignedTo: "agent", isReviewData });
    }
    expect(fixtures.email).not.toHaveBeenCalled();
    expect(fixtures.due).not.toHaveBeenCalled();
    expect(fixtures.reminder).not.toHaveBeenCalled();
  });

  it("sends reminders only for own-cohort records even when foreign data is accidentally assigned", async () => {
    fixtures.users = [
      { _id: "ordinary", email: "ordinary@example.test" },
      { _id: "reviewer", email: "reviewer@example.test", isReviewAccount: true },
    ];
    const dueDate = new Date(Date.now() + 60 * 60 * 1000);
    fixtures.leads = [
      { _id: "normal", assignedTo: "ordinary", status: "new_lead", dueDate, clientName: "Normal fixture" },
      { _id: "review", assignedTo: "reviewer", isReviewData: true, status: "new_lead", dueDate, clientName: "Review fixture" },
      { _id: "cross-review", assignedTo: "ordinary", isReviewData: true, status: "new_lead", dueDate, clientName: "Wrong review fixture" },
      { _id: "cross-normal", assignedTo: "reviewer", status: "new_lead", dueDate, clientName: "Wrong normal fixture" },
    ];

    await runCrmTaskReminderSweep();

    expect(fixtures.due.mock.calls.map(([message]) => [message.userId, message.leadId]))
      .toEqual([["ordinary", "normal"], ["reviewer", "review"]]);
    expect(fixtures.email.mock.calls.map(([recipient, payload]) => [recipient.email, payload.tasks.map((task: any) => task.clientName)]))
      .toEqual([["ordinary@example.test", ["Normal fixture"]], ["reviewer@example.test", ["Review fixture"]]]);
    expect(fixtures.update.mock.calls.map(([filter]) => filter._id)).toEqual(["normal", "review"]);
    expect(fixtures.reminder.mock.calls.map(([payload]) => payload.unfinishedCount)).toEqual([1, 1]);
  });
});
