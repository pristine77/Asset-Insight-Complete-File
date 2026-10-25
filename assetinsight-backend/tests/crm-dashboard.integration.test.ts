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

const AS_OF = new Date("2026-09-23T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const STATUSES = ["new_lead", "contacted", "inspection_required", "inspection_complete", "proposal_submitted", "decision_pending", "won", "lost"];
let mongo: MongoMemoryServer;
let app: typeof import("../src/app.js")["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let CrmLead: typeof import("../src/models/crmLead.model.js")["default"];
let owner: any;
let other: any;

function authorization(user = owner) {
  return `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET!, { expiresIn: "30m" })}`;
}
async function makeUser(extra: Record<string, unknown> = {}) {
  const id = new mongoose.Types.ObjectId();
  return User.create({
    _id: id, username: `Agent ${id}`, email: `${id}@example.test`, password: "test-password",
    authProvider: "email", isVerified: true, role: "user", isCrmAgent: true, ...extra,
  });
}
function lead(extra: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(), clientName: "Prospect", companyName: "Example company",
    title: "CRM Follow-up", assignedTo: owner._id, assignedBy: other._id,
    status: "new_lead", leadSource: "generic", taskStartDate: new Date(AS_OF.getTime() - DAY),
    createdAt: new Date(AS_OF.getTime() - 2 * DAY), ...extra,
  };
}
function getDashboard(user = owner) {
  return request(app).get("/api/crm/tasks/dashboard").set("Authorization", authorization(user));
}

beforeAll(async () => {
  vi.stubEnv("RESEND_API_KEY", "re_crm_dashboard_test_only");
  vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: CrmLead } = await import("../src/models/crmLead.model.js"));
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AS_OF);
  owner = await makeUser();
  other = await makeUser();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  vi.unstubAllEnvs();
});

describe.sequential("owner-scoped CRM dashboard", () => {
  it("returns actual zero counts for an enabled agent with no tasks or coverage", async () => {
    const response = await getDashboard();
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      asOf: AS_OF.toISOString(), total: 0,
      statusCounts: STATUSES.map(status => ({ _id: status, count: 0 })),
      leadSourceCounts: { total: 0, generic: 0, organic: 0 }, dueCounts: { overdue: 0, upcoming: 0 },
      overdueTasks: [], upcomingTasks: [],
    });
  });

  it("counts all owned leads beyond 200 rows, projects before materializing, and caps both previews", async () => {
    const upcoming = Array.from({ length: 213 }, (_, i) => lead({
      clientName: `Upcoming ${i}`, status: "contacted", leadSource: i % 2 ? "organic" : "generic",
      dueDate: new Date(AS_OF.getTime() + (i + 1) * 1000),
    }));
    const overdue = Array.from({ length: 11 }, (_, i) => lead({ clientName: `Overdue ${i}`, dueDate: new Date(AS_OF.getTime() - (11 - i) * 1000) }));
    const heavy = { importData: { private: "x".repeat(300_000) }, notes: "Private notes", email: "private@example.test", latestComment: "Not a dashboard field", latestAttachmentUrls: ["https://files.example.test/private"], updates: Array.from({ length: 300 }, () => ({ comment: "Private activity", createdBy: owner._id })) };
    Object.assign(upcoming[0], heavy);
    await CrmLead.collection.insertMany([...upcoming, ...overdue, lead({ assignedTo: other._id, dueDate: AS_OF }), lead({ assignedTo: null, dueDate: AS_OF })] as any[]);
    const before = await CrmLead.collection.findOne({ _id: upcoming[0]._id });
    const aggregate = vi.spyOn(CrmLead, "aggregate");
    const response = await getDashboard();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 224, leadSourceCounts: { total: 224, generic: 118, organic: 106 }, dueCounts: { overdue: 11, upcoming: 213 } });
    expect(response.body.statusCounts).toEqual(STATUSES.map(status => ({ _id: status, count: status === "contacted" ? 213 : status === "new_lead" ? 11 : 0 })));
    expect(response.body.upcomingTasks.map((item: any) => item._id)).toEqual(upcoming.slice(0, 5).map(item => String(item._id)));
    expect(response.body.overdueTasks.map((item: any) => item._id)).toEqual(overdue.slice(0, 5).map(item => String(item._id)));
    const allowed = new Set(["_id", "title", "clientName", "companyName", "status", "lostReason", "dueDate", "taskStartDate"]);
    for (const item of [...response.body.upcomingTasks, ...response.body.overdueTasks]) expect(Object.keys(item).every(key => allowed.has(key))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response.body))).toBeLessThan(6_000);
    expect(aggregate).toHaveBeenCalledOnce();
    const pipeline = aggregate.mock.calls[0][0]! as any[];
    expect(pipeline[0]).toEqual({ $match: { assignedTo: owner._id, isReviewData: { $ne: true } } });
    expect(pipeline[1].$project).not.toHaveProperty("updates");
    expect(pipeline[1].$project).not.toHaveProperty("importData");
    expect(await CrmLead.collection.findOne({ _id: upcoming[0]._id })).toEqual(before);
  });

  it("uses the same legacy status and Quick Add source semantics without normalizing stored data", async () => {
    const legacyStatuses = ["pending", "in_progress", "no_answer", "completed", "not_interested", "unknown"];
    const rows = legacyStatuses.map((status, index) => lead({
      status, title: index === 1 ? "quick add legacy" : "Imported lead", leadSource: index === 2 ? "organic" : "generic",
      dueDate: new Date(AS_OF.getTime() - 1000), lostReason: "competitor",
    }));
    rows.push(lead({ title: "Quick Add without source", leadSource: undefined, dueDate: AS_OF }));
    await CrmLead.collection.insertMany(rows as any[]);
    const before = await CrmLead.collection.find({}).sort({ _id: 1 }).toArray();
    const response = await getDashboard();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 7, leadSourceCounts: { total: 7, generic: 4, organic: 3 }, dueCounts: { overdue: 4, upcoming: 1 } });
    expect(response.body.statusCounts).toEqual(STATUSES.map(status => ({ _id: status, count: status === "new_lead" ? 3 : status === "contacted" ? 2 : status === "won" || status === "lost" ? 1 : 0 })));
    expect(response.body.overdueTasks.every((item: any) => ["new_lead", "contacted"].includes(item.status) && !item.lostReason)).toBe(true);
    expect(await CrmLead.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    const legacyTotals = await request(app).get("/api/crm/tasks/my?status=all&view=summary&limit=1").set("Authorization", authorization());
    expect(response.body.total).toBe(legacyTotals.body.total);
    expect(response.body.leadSourceCounts).toEqual(legacyTotals.body.leadSourceCounts);
    expect(response.body.statusCounts.filter((entry: any) => entry.count)).toEqual(legacyTotals.body.statusCounts);
  });

  it("uses a single clock with inclusive seven-day boundaries, excludes closed/undated tasks, and includes future-start due tasks", async () => {
    await CrmLead.collection.insertMany([
      lead({ clientName: "Just overdue", dueDate: new Date(AS_OF.getTime() - 1) }),
      lead({ clientName: "Due now", dueDate: AS_OF, taskStartDate: new Date(AS_OF.getTime() + DAY) }),
      lead({ clientName: "Seven days", dueDate: new Date(AS_OF.getTime() + 7 * DAY) }),
      lead({ clientName: "Too late", dueDate: new Date(AS_OF.getTime() + 7 * DAY + 1) }),
      lead({ clientName: "No due" }), lead({ clientName: "Null due", dueDate: null }),
      lead({ clientName: "String due", dueDate: "2026-09-22T00:00:00Z" }),
      lead({ status: "won", dueDate: new Date(AS_OF.getTime() - 1) }),
      lead({ status: "lost", dueDate: AS_OF }), lead({ status: "completed", dueDate: AS_OF }),
      lead({ status: "not_interested", dueDate: new Date(AS_OF.getTime() - 1) }),
    ] as any[]);
    const response = await getDashboard();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ asOf: AS_OF.toISOString(), total: 11, dueCounts: { overdue: 1, upcoming: 2 } });
    expect(response.body.overdueTasks.map((item: any) => item.clientName)).toEqual(["Just overdue"]);
    expect(response.body.upcomingTasks.map((item: any) => item.clientName)).toEqual(["Due now", "Seven days"]);
    for (const due of ["overdue", "upcoming"] as const) {
      const list = await request(app).get(`/api/crm/tasks/my?status=all&view=summary&due=${due}&limit=1`).set("Authorization", authorization());
      expect(response.body.dueCounts[due]).toBe(list.body.total);
    }
  });

  it("orders due previews by due/start/created and uses IDs to resolve equal dates", async () => {
    const id = (number: number) => new mongoose.Types.ObjectId(number.toString(16).padStart(24, "0"));
    const rows = [
      lead({ _id: id(4), clientName: "Later start", dueDate: AS_OF, taskStartDate: AS_OF }),
      lead({ _id: id(3), clientName: "Older created", dueDate: AS_OF }),
      lead({ _id: id(2), clientName: "Same dates second", dueDate: AS_OF, createdAt: AS_OF }),
      lead({ _id: id(1), clientName: "Same dates first", dueDate: AS_OF, createdAt: AS_OF }),
    ];
    await CrmLead.collection.insertMany(rows as any[]);
    const response = await getDashboard();
    expect(response.body.upcomingTasks.map((item: any) => item._id)).toEqual([1, 2, 3, 4].map(number => String(id(number))));
  });

  it("rechecks assignment and never includes another agent's leads", async () => {
    const owned = lead({ dueDate: AS_OF });
    await CrmLead.collection.insertMany([owned, lead({ assignedTo: other._id, dueDate: AS_OF })] as any[]);
    expect((await getDashboard()).body.total).toBe(1);
    await CrmLead.updateOne({ _id: owned._id }, { $set: { assignedTo: other._id } });
    expect((await getDashboard()).body).toMatchObject({ total: 0, upcomingTasks: [] });
    expect((await getDashboard(other)).body.total).toBe(2);
  });

  it("reports unavailable counts rather than fabricated zeros when aggregation fails", async () => {
    vi.spyOn(CrmLead, "aggregate").mockRejectedValueOnce(new Error("Isolated read failure"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await getDashboard();
    expect(response.status).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ message: "Failed to fetch CRM dashboard" });
  });

  it.each(["disabled", "blocked", "admin", "unauthenticated"])("enforces current CRM entitlement/auth for %s callers", async mode => {
    await CrmLead.collection.insertOne(lead({ dueDate: AS_OF }) as any);
    if (mode === "disabled") await User.updateOne({ _id: owner._id }, { $set: { isCrmAgent: false } });
    if (mode === "blocked") await User.updateOne({ _id: owner._id }, { $set: { isBlocked: true } });
    if (mode === "admin") await User.updateOne({ _id: owner._id }, { $set: { isCrmAgent: false, role: "superadmin" } });
    const response = mode === "unauthenticated" ? await request(app).get("/api/crm/tasks/dashboard") : await getDashboard();
    expect(response.status).toBe(mode === "unauthenticated" ? 401 : 403);
    expect(response.body).not.toHaveProperty("total");
    expect(response.body).not.toHaveProperty("upcomingTasks");
  });

  it.each(["ownerId=000000000000000000000001", "status=all", "q=contact", "limit=200", "from=2026-09-01", "x=1&x=2"])("rejects dashboard query parameters: %s", async query => {
    const response = await request(app).get(`/api/crm/tasks/dashboard?${query}`).set("Authorization", authorization());
    expect(response.status).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ message: "CRM dashboard does not accept query parameters" });
  });

  it("retains approved-device admission and a specific route before dynamic task IDs", async () => {
    expect((await getDashboard()).status).toBe(200);
    vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "on");
    try {
      const response = await getDashboard();
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("DEVICE_CONTEXT_REQUIRED");
    } finally { vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off"); }
    const existing = await request(app).get("/api/crm/tasks/my?view=summary").set("Authorization", authorization());
    expect(existing.status).toBe(200);
    expect(existing.body).toHaveProperty("items");
  });
});
