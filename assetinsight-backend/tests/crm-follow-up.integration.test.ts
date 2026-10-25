/**
 * CRM follow-up dates end to end (owner decision 2026-10-11): Task Update sets,
 * keeps, moves and ends them; the calendar endpoint reads them; the follow-up
 * job reminds at 8 a.m. / 1 hour before and each morning while overdue, and
 * keeps one Outlook event in step. Also the hourly reminder job's unset fix.
 * Push delivery and Microsoft Graph are stand-ins; MongoDB and Express are real.
 */
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => {
  const config = () => ({ parsed: {} });
  return { config, default: { config } };
});
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
const pushes = vi.hoisted(() => ({ followUp: vi.fn(), due: vi.fn(), reminder: vi.fn() }));
vi.mock("../src/service/crmPushService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/service/crmPushService.js")>()),
  sendCrmFollowUpNotification: pushes.followUp,
  sendCrmDueNotification: pushes.due,
  sendCrmReminderNotification: pushes.reminder,
}));
vi.mock("../src/service/crmEmailService.js", () => ({ sendCrmTaskDigestEmail: vi.fn(async () => undefined) }));
const graph = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, post: graph.post, patch: graph.patch, delete: graph.delete } };
});

// Sunday 2026-10-11, noon in Regina (UTC-6, no DST).
const AS_OF = new Date("2026-10-11T18:00:00.000Z");
const REGINA = "America/Regina";
const DAY = 24 * 60 * 60 * 1000;
let mongo: MongoMemoryServer;
let app: typeof import("../src/app.js")["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let CrmLead: typeof import("../src/models/crmLead.model.js")["default"];
let runCrmFollowUpSweep: typeof import("../src/jobs/crmFollowUpJob.js")["runCrmFollowUpSweep"];
let runCrmTaskReminderSweep: typeof import("../src/jobs/crmTaskReminderJob.js")["runCrmTaskReminderSweep"];
let agent: any;
let other: any;

const at = (iso: string) => vi.setSystemTime(new Date(iso));
function authorization(user = agent) {
  return `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET!, { expiresIn: "30m" })}`;
}
async function makeUser(extra: Record<string, unknown> = {}) {
  const id = new mongoose.Types.ObjectId();
  return User.create({
    _id: id, username: `Agent ${id}`, email: `${id}@example.test`, password: "test-password",
    authProvider: "email", isVerified: true, role: "user", isCrmAgent: true, ...extra,
  });
}
async function makeLead(extra: Record<string, unknown> = {}) {
  const lead = await CrmLead.create({
    clientName: "Curtis Metz", title: "CRM Follow-up", assignedTo: agent._id, assignedBy: other._id,
    status: "contacted", leadSource: "organic", statusChangedAt: AS_OF, taskStartDate: AS_OF,
    dueDate: new Date(AS_OF.getTime() + 7 * DAY), ...extra,
  });
  return lead as any;
}
function update(lead: any, body: Record<string, unknown>, user = agent) {
  return request(app).patch(`/api/crm/tasks/${lead._id}/update`).set("Authorization", authorization(user)).send(body);
}
const reload = async (lead: any) => (await CrmLead.findById(lead._id).lean()) as any;
const sentFollowUps = () => pushes.followUp.mock.calls.map(([input]) => ({ lead: input.leadId, kind: input.kind }));

beforeAll(async () => {
  vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: CrmLead } = await import("../src/models/crmLead.model.js"));
  ({ runCrmFollowUpSweep } = await import("../src/jobs/crmFollowUpJob.js"));
  ({ runCrmTaskReminderSweep } = await import("../src/jobs/crmTaskReminderJob.js"));
  await CrmLead.syncIndexes();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await CrmLead.syncIndexes();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AS_OF);
  for (const mock of [pushes.followUp, pushes.due, pushes.reminder, graph.post, graph.patch, graph.delete]) mock.mockReset();
  for (const push of [pushes.followUp, pushes.due, pushes.reminder]) push.mockResolvedValue(undefined);
  agent = await makeUser();
  other = await makeUser();
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  vi.unstubAllEnvs();
});

describe.sequential("Task Update with a follow-up date", () => {
  it("sets a date-only follow-up: due all that day, reminder at 8 a.m., recorded on the update", async () => {
    const lead = await makeLead();
    const res = await update(lead, { comment: "Will visit", status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    const saved = await reload(lead);
    expect(saved.followUpTime).toBeUndefined();
    expect(saved.dueDate.toISOString()).toBe("2026-10-21T05:59:59.999Z");
    expect(saved.followUpRemindAt.toISOString()).toBe("2026-10-20T14:00:00.000Z");
    expect(saved.updates.at(-1).reminderDate.toISOString()).toBe("2026-10-20T14:00:00.000Z");
    expect(saved.followUpOutlook).toMatchObject({ syncPending: true, version: 1 });
  });

  it("sets a timed follow-up: due at the time, reminder 1 hour before", async () => {
    const lead = await makeLead();
    expect((await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTime: "15:00", followUpTimeZone: REGINA })).status).toBe(200);
    const saved = await reload(lead);
    expect(saved.followUpTime).toBe("15:00");
    expect(saved.dueDate.toISOString()).toBe("2026-10-20T21:00:00.000Z");
    expect(saved.followUpRemindAt.toISOString()).toBe("2026-10-20T20:00:00.000Z");
  });

  it("refuses a past date before storing anything", async () => {
    const lead = await makeLead();
    const res = await update(lead, { comment: "Too late", status: "contacted", followUpDate: "2026-10-10" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CRM_FOLLOW_UP_INVALID");
    const saved = await reload(lead);
    expect(saved.updates).toHaveLength(0);
    expect(saved.callAttempts).toBe(0);
    expect(saved.followUpDate).toBeUndefined();
  });

  it("keeps an upcoming follow-up through updates that leave it alone (the website sends no follow-up fields)", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    at("2026-10-15T18:00:00.000Z");
    expect((await update(lead, { comment: "Confirmed the visit", status: "inspection_required" })).status).toBe(200);
    const saved = await reload(lead);
    expect(saved.status).toBe("inspection_required");
    expect(saved.followUpDate).toBe("2026-10-20");
    expect(saved.dueDate.toISOString()).toBe("2026-10-21T05:59:59.999Z");
  });

  it("ends a passed follow-up on the next update; the 7-day cadence resumes from it", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    at("2026-10-22T16:00:00.000Z");
    expect((await update(lead, { comment: "Visited", status: "contacted" })).status).toBe(200);
    const saved = await reload(lead);
    expect(saved.followUpDate).toBeUndefined();
    expect(saved.followUpAt).toBeUndefined();
    expect(saved.dueDate.toISOString()).toBe(new Date(Date.parse("2026-10-22T16:00:00.000Z") + 7 * DAY).toISOString());
  });

  it("clears on request and when the lead is won; refuses a date on a won lead", async () => {
    const cleared = await makeLead();
    await update(cleared, { status: "contacted", followUpDate: "2026-10-20" });
    expect((await update(cleared, { status: "contacted", clearFollowUp: "true" })).status).toBe(200);
    expect((await reload(cleared)).followUpDate).toBeUndefined();

    const won = await makeLead();
    await update(won, { status: "contacted", followUpDate: "2026-10-20" });
    expect((await update(won, { status: "won" })).status).toBe(200);
    expect((await reload(won)).followUpDate).toBeUndefined();

    const refused = await update(await makeLead(), { status: "won", followUpDate: "2026-10-20" });
    expect(refused.status).toBe(400);
  });
});

describe.sequential("the follow-up calendar", () => {
  it("returns this agent's follow-ups in the range and every passed one", async () => {
    const inRange = await makeLead({ clientName: "In range" });
    const later = await makeLead({ clientName: "Later" });
    const theirs = await makeLead({ clientName: "Someone else's", assignedTo: other._id });
    const passed = await makeLead({ clientName: "Passed" });
    await update(inRange, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    await update(later, { status: "contacted", followUpDate: "2026-12-20", followUpTimeZone: REGINA });
    await update(theirs, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA }, other);
    await update(passed, { status: "contacted", followUpDate: "2026-10-12", followUpTime: "09:00", followUpTimeZone: REGINA });
    at("2026-10-13T18:00:00.000Z");

    const res = await request(app).get("/api/crm/tasks/follow-ups?from=2026-10-01&to=2026-10-31&timeZone=America/Regina")
      .set("Authorization", authorization());
    expect(res.status).toBe(200);
    expect(res.body.items.map((row: any) => row.clientName)).toEqual(["Passed", "In range"]);
    expect(res.body.overdue.map((row: any) => row.clientName)).toEqual(["Passed"]);
    expect(res.body.items[1]).toMatchObject({ followUpDate: "2026-10-20", status: "contacted" });
    expect(res.body.items[1].updates).toBeUndefined();
  });

  it("validates the range and zone", async () => {
    const get = (query: string) => request(app).get(`/api/crm/tasks/follow-ups?${query}`).set("Authorization", authorization());
    expect((await get("from=2026-10-31&to=2026-10-01")).status).toBe(400);
    expect((await get("from=2026-10-01&to=2027-01-31")).status).toBe(400);
    expect((await get("from=2026-10-01&to=2026-10-31&timeZone=Mars/Base")).status).toBe(400);
  });
});

describe.sequential("the follow-up job's reminders", () => {
  it("reminds once at 8 a.m. on the day of a date-only follow-up", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    await runCrmFollowUpSweep(new Date("2026-10-20T13:59:00.000Z"));
    expect(pushes.followUp).not.toHaveBeenCalled();
    await runCrmFollowUpSweep(new Date("2026-10-20T14:01:00.000Z"));
    await runCrmFollowUpSweep(new Date("2026-10-20T14:06:00.000Z"));
    expect(sentFollowUps()).toEqual([{ lead: String(lead._id), kind: "upcoming" }]);
    expect(pushes.followUp.mock.calls[0][0]).toMatchObject({ followUpDate: "2026-10-20", timeZone: REGINA, userId: String(agent._id) });
  });

  it("reminds 1 hour before a timed follow-up", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTime: "15:00", followUpTimeZone: REGINA });
    await runCrmFollowUpSweep(new Date("2026-10-20T19:58:00.000Z"));
    expect(pushes.followUp).not.toHaveBeenCalled();
    await runCrmFollowUpSweep(new Date("2026-10-20T20:01:00.000Z"));
    expect(sentFollowUps()).toEqual([{ lead: String(lead._id), kind: "upcoming" }]);
  });

  it("while overdue, reminds each morning from 8 a.m., starting the day after", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    await runCrmFollowUpSweep(new Date("2026-10-20T14:01:00.000Z")); // the day's reminder
    pushes.followUp.mockClear();
    for (const iso of ["2026-10-21T05:00:00.000Z", "2026-10-21T13:00:00.000Z"]) await runCrmFollowUpSweep(new Date(iso)); // 23:00 on the day, 07:00 next day
    expect(pushes.followUp).not.toHaveBeenCalled();
    await runCrmFollowUpSweep(new Date("2026-10-21T14:05:00.000Z")); // 08:05
    await runCrmFollowUpSweep(new Date("2026-10-21T18:00:00.000Z")); // noon, same day
    await runCrmFollowUpSweep(new Date("2026-10-22T14:05:00.000Z")); // next morning
    expect(sentFollowUps()).toEqual([
      { lead: String(lead._id), kind: "overdue" },
      { lead: String(lead._id), kind: "overdue" },
    ]);
  });

  it("does not remind a blocked agent, and the hourly job leaves follow-up leads to this job", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-12", followUpTimeZone: REGINA });
    at("2026-10-12T14:01:00.000Z");
    await runCrmTaskReminderSweep();
    expect(pushes.due).not.toHaveBeenCalled();
    await User.updateOne({ _id: agent._id }, { $set: { isBlocked: true } });
    await runCrmFollowUpSweep(new Date("2026-10-12T14:01:00.000Z"));
    expect(pushes.followUp).not.toHaveBeenCalled();
    expect((await reload(lead)).followUpReminderSentAt).toBeTruthy();
  });
});

describe.sequential("the hourly reminder job's flags (fixed 2026-10-11)", () => {
  it("moves an overdue cadence lead forward and really clears both flags", async () => {
    const lead = await makeLead({ dueDate: new Date(AS_OF.getTime() - 60_000), dueSoonPushSentAt: new Date(AS_OF.getTime() - DAY) });
    await runCrmTaskReminderSweep();
    expect(pushes.due).toHaveBeenCalledTimes(1);
    const saved = await reload(lead);
    expect(saved.dueDate.toISOString()).toBe(new Date(AS_OF.getTime() + 7 * DAY).toISOString());
    expect(saved).not.toHaveProperty("dueSoonPushSentAt");
    expect(saved).not.toHaveProperty("overduePushSentAt");
  });

  it("pushes about an overdue New Lead once, not every sweep", async () => {
    await makeLead({ status: "new_lead", dueDate: new Date(AS_OF.getTime() - 60_000) });
    await runCrmTaskReminderSweep();
    await runCrmTaskReminderSweep();
    expect(pushes.due).toHaveBeenCalledTimes(1);
  });
});

describe.sequential("the follow-up's Outlook event", () => {
  beforeEach(async () => {
    await User.updateOne({ _id: agent._id }, { $set: {
      msOutlookCalendarConnected: true, msOutlookAccessToken: "test-graph-token",
      msOutlookTokenExpiresAt: new Date(AS_OF.getTime() + 60 * DAY),
    } });
    graph.post.mockResolvedValue({ data: { id: "event-1", webLink: "https://outlook.test/event-1" } });
    graph.patch.mockResolvedValue({ data: { id: "event-1" } });
    graph.delete.mockResolvedValue({ status: 204 });
  });

  it("creates one all-day event, moves it with the date and removes it when cleared", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    await runCrmFollowUpSweep(AS_OF);
    expect(graph.post).toHaveBeenCalledTimes(1);
    const [url, payload] = graph.post.mock.calls[0];
    expect(url).toMatch(/\/me\/events$/);
    expect(payload).toMatchObject({
      subject: "Follow up: Curtis Metz", isAllDay: true, isReminderOn: false,
      start: { dateTime: "2026-10-20T00:00:00", timeZone: "Canada Central Standard Time" },
      end: { dateTime: "2026-10-21T00:00:00", timeZone: "Canada Central Standard Time" },
    });
    expect(payload.transactionId).toMatch(new RegExp(`^crm-follow-up-${lead._id}-[a-f0-9-]{36}$`));
    expect((await reload(lead)).followUpOutlook).toMatchObject({ eventId: "event-1", syncPending: false });

    await update(lead, { status: "contacted", followUpDate: "2026-10-21", followUpTime: "10:00", followUpTimeZone: REGINA });
    await runCrmFollowUpSweep(AS_OF);
    expect(graph.patch).toHaveBeenCalledTimes(1);
    expect(graph.patch.mock.calls[0][1]).toMatchObject({
      isAllDay: false, isReminderOn: true, reminderMinutesBeforeStart: 60,
      start: { dateTime: "2026-10-21T16:00:00.000Z", timeZone: "UTC" },
    });

    await update(lead, { status: "contacted", clearFollowUp: "true" });
    await runCrmFollowUpSweep(AS_OF);
    expect(graph.delete).toHaveBeenCalledTimes(1);
    expect(graph.delete.mock.calls[0][0]).toMatch(/\/me\/events\/event-1$/);
    const saved = await reload(lead);
    expect(saved.followUpOutlook.eventId).toBeUndefined();
    expect(saved.followUpOutlook.syncPending).toBe(false);
  });

  it("retries a failed create later and never blocks the follow-up itself", async () => {
    graph.post.mockRejectedValueOnce(Object.assign(new Error("Rate limited"), { response: { status: 429 } }));
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    await runCrmFollowUpSweep(AS_OF);
    let saved = await reload(lead);
    expect(saved.followUpDate).toBe("2026-10-20");
    expect(saved.followUpOutlook).toMatchObject({ syncPending: true, attempts: 1, lastError: expect.stringContaining("Outlook is busy") });
    expect(saved.followUpOutlook.nextAttemptAt.toISOString()).toBe(new Date(AS_OF.getTime() + 5 * 60 * 1000).toISOString());
    await runCrmFollowUpSweep(new Date(AS_OF.getTime() + 6 * 60 * 1000));
    saved = await reload(lead);
    expect(saved.followUpOutlook).toMatchObject({ eventId: "event-1", syncPending: false, attempts: 0 });
  });

  it("does nothing in Outlook for an agent who has not connected it", async () => {
    await User.updateOne({ _id: agent._id }, { $set: { msOutlookCalendarConnected: false } });
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    await runCrmFollowUpSweep(AS_OF);
    expect(graph.post).not.toHaveBeenCalled();
    expect((await reload(lead)).followUpOutlook.syncPending).toBe(false);
  });

  it("the Add to Outlook button makes the follow-up's event, not a second one", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    const res = await request(app).post(`/api/crm/tasks/${lead._id}/calendar/ms/outlook`).set("Authorization", authorization());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ eventId: "event-1", message: "Follow-up added to Outlook calendar" });
    await runCrmFollowUpSweep(AS_OF);
    expect(graph.post).toHaveBeenCalledTimes(1);
  });

  it("returns queued rather than added when another request owns the provider operation", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    let finish!: (value: unknown) => void;
    graph.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = request(app).post(`/api/crm/tasks/${lead._id}/calendar/ms/outlook`).set("Authorization", authorization()).then(res => res);
    await vi.waitFor(() => expect(graph.post).toHaveBeenCalledTimes(1));
    const second = await request(app).post(`/api/crm/tasks/${lead._id}/calendar/ms/outlook`).set("Authorization", authorization());
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ pending: true, message: expect.stringContaining("queued") });
    expect(second.body.eventId).toBeUndefined();
    finish({ data: { id: "event-1" } });
    expect((await first).status).toBe(201);
    expect(graph.post).toHaveBeenCalledTimes(1);
  });

  it("reports uncertain bulk outcomes as pending, never created or automatically retried", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    graph.post.mockResolvedValueOnce({ data: {} });
    const send = () => request(app).post("/api/crm/tasks/calendar/ms/outlook/bulk").set("Authorization", authorization()).send({ taskIds: [String(lead._id)] });
    for (let i = 0; i < 2; i += 1) {
      const res = await send();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ createdCount: 0, failedCount: 0, pendingCount: 1, created: [], failed: [],
        pending: [{ taskId: String(lead._id), reason: expect.stringContaining("did not confirm") }] });
    }
    expect(graph.post).toHaveBeenCalledTimes(1);
  });

  it.each(["single", "bulk"])("does not return a reassigned owner's event to the original %s requester", async mode => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    await User.updateOne({ _id: other._id }, { $set: {
      msOutlookCalendarConnected: true, msOutlookAccessToken: "other-synthetic-token",
      msOutlookTokenExpiresAt: new Date(AS_OF.getTime() + 60 * DAY),
    } });
    let finish!: (value: unknown) => void;
    graph.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ data: { id: "new-owner-private-event", webLink: "https://outlook.test/new-owner-private-event" } });
    const response = mode === "single"
      ? request(app).post(`/api/crm/tasks/${lead._id}/calendar/ms/outlook`).set("Authorization", authorization()).then(res => res)
      : request(app).post("/api/crm/tasks/calendar/ms/outlook/bulk").set("Authorization", authorization())
        .send({ taskIds: [String(lead._id)] }).then(res => res);
    await vi.waitFor(() => expect(graph.post).toHaveBeenCalledTimes(1));
    await CrmLead.updateOne({ _id: lead._id }, { $set: { assignedTo: other._id } });
    finish({ data: { id: "old-owner-event", webLink: "https://outlook.test/old-owner-event" } });
    const res = await response;
    expect(res.status).toBe(mode === "single" ? 409 : 200);
    if (mode === "bulk") expect(res.body).toMatchObject({ createdCount: 0, failedCount: 1, pendingCount: 0, created: [] });
    expect(JSON.stringify(res.body)).toContain("assignment or your CRM access changed");
    expect(JSON.stringify(res.body)).not.toMatch(/new-owner-private-event|old-owner-event|webLink|eventId/);
    expect((await reload(lead)).followUpOutlook).toMatchObject({ eventId: "new-owner-private-event", syncPending: false });
    expect(String((await reload(lead)).followUpOutlook.userId)).toBe(String(other._id));
    expect(graph.delete).toHaveBeenCalledTimes(1);
    expect(graph.post).toHaveBeenCalledTimes(2);
  });

  it.each([{ isBlocked: true }, { isCrmAgent: false }, { isReviewAccount: true }])("withholds a late receipt after account access changes: %j", async changed => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    let finish!: (value: unknown) => void;
    graph.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const response = request(app).post(`/api/crm/tasks/${lead._id}/calendar/ms/outlook`).set("Authorization", authorization()).then(res => res);
    await vi.waitFor(() => expect(graph.post).toHaveBeenCalledTimes(1));
    await User.collection.updateOne({ _id: agent._id }, { $set: changed });
    finish({ data: { id: "retained-event", webLink: "https://outlook.test/retained-event" } });
    const res = await response;
    expect(res.status).toBe(409);
    expect(res.body.eventId).toBeUndefined();
    expect(res.body.webLink).toBeUndefined();
    expect((await reload(lead)).followUpOutlook.eventId).toBe("retained-event");
  });

  it("withholds another owner's link after an A-to-B-to-A reassignment even when mailbox event IDs collide", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    await User.updateOne({ _id: other._id }, { $set: {
      msOutlookCalendarConnected: true, msOutlookAccessToken: "other-synthetic-token",
      msOutlookTokenExpiresAt: new Date(AS_OF.getTime() + 60 * DAY),
    } });
    let finish!: (value: unknown) => void;
    graph.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ data: { id: "same-mailbox-local-id", webLink: "https://outlook.test/other-private-event" } });
    const response = request(app).post(`/api/crm/tasks/${lead._id}/calendar/ms/outlook`).set("Authorization", authorization()).then(res => res);
    await vi.waitFor(() => expect(graph.post).toHaveBeenCalledTimes(1));
    await CrmLead.updateOne({ _id: lead._id }, { $set: { assignedTo: other._id } });
    const find = User.findOne.bind(User);
    const accessRead = vi.spyOn(User, "findOne").mockImplementation(((filter: any, ...args: any[]) => {
      const query = (find as any)(filter, ...args);
      if (filter?.isCrmAgent === true && filter?.isBlocked && !("msOutlookCalendarConnected" in filter)) {
        // A concurrent completed reconciliation between service result and DTO
        // authorization. Event identifiers need not be unique across mailboxes.
        const execute = query.exec.bind(query);
        query.exec = async () => {
          await CrmLead.collection.updateOne({ _id: lead._id }, {
            $set: { assignedTo: agent._id, "followUpOutlook.userId": agent._id,
              "followUpOutlook.eventId": "same-mailbox-local-id", "followUpOutlook.syncPending": false },
          });
          return execute();
        };
      }
      return query;
    }) as any);
    try {
      finish({ data: { id: "old-event" } });
      const res = await response;
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ pending: true, message: expect.stringContaining("calendar changed") });
      expect(res.body.eventId).toBeUndefined();
      expect(res.body.webLink).toBeUndefined();
    } finally { accessRead.mockRestore(); }
  });

  it("refuses admin lead/batch deletion while calendar evidence is retained", async () => {
    const lead = await makeLead({ sourceBatchId: "synthetic-calendar-batch", latestAttachmentUrls: ["https://synthetic.invalid/retained.jpg"] });
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    const admin = await makeUser({ role: "superadmin" });
    for (const url of [`/api/crm/admin/leads/${lead._id}`, "/api/crm/admin/import-files/synthetic-calendar-batch"]) {
      const response = await request(app).delete(url).set("Authorization", authorization(admin));
      expect(response.status).toBe(409);
      expect(response.body.message).toContain("Clear the follow-up");
      expect((await reload(lead)).latestAttachmentUrls).toEqual(["https://synthetic.invalid/retained.jpg"]);
    }
  });

  it("excludes private operation and deletion state from aggregation detail and all ordinary CRM reads", async () => {
    const lead = await makeLead();
    await update(lead, { status: "contacted", followUpDate: "2026-10-20", followUpTimeZone: REGINA });
    graph.post.mockResolvedValueOnce({ data: {} });
    await request(app).post(`/api/crm/tasks/${lead._id}/calendar/ms/outlook`).set("Authorization", authorization());
    await CrmLead.updateOne({ _id: lead._id }, { $set: { crmDeletionToken: "synthetic-private-deletion-token" } });
    for (const url of [
      `/api/crm/tasks/${lead._id}`, `/api/crm/tasks/${lead._id}/updates`,
      "/api/crm/tasks/my?status=all", "/api/crm/tasks/my?status=all&view=summary", "/api/crm/tasks/dashboard",
      "/api/crm/tasks/follow-ups?from=2026-10-01&to=2026-10-31&timeZone=America%2FRegina",
    ]) {
      const response = await request(app).get(url).set("Authorization", authorization());
      expect(response.status, url).toBe(200);
      const body = JSON.stringify(response.body);
      expect(body, url).not.toContain("followUpOutlookOperation");
      expect(body, url).not.toContain("crmDeletionToken");
      expect(body, url).not.toContain("synthetic-private-deletion-token");
    }
  });
});
