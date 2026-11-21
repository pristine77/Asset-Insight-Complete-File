/**
 * Moving CRM leads in bulk, and vacant pools (owner, 2026-11-20: Tanner's
 * 15,000 Winnipeg leads after his move to Edmonton — "never delete leads, but
 * remove/park them away", and hand them to whoever takes the territory).
 * Through the real API on an in-memory database.
 */
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => {
  const config = () => ({ parsed: {} });
  return { config, default: { config } };
});
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
const emails = vi.hoisted(() => [] as Array<{ to: string; tasks: number; total?: number }>);
const pushes = vi.hoisted(() => [] as Array<{ userId: string; count?: number; reason?: string }>);
vi.mock("../src/service/crmEmailService.js", async (original) => ({
  ...(await original<typeof import("../src/service/crmEmailService.js")>()),
  sendCrmTasksAssignedEmail: vi.fn(async (user: { email?: string }, tasks: unknown[], total?: number) => {
    emails.push({ to: String(user.email), tasks: tasks.length, total });
  }),
}));
vi.mock("../src/service/crmPushService.js", async (original) => ({
  ...(await original<typeof import("../src/service/crmPushService.js")>()),
  sendCrmNewTaskNotification: vi.fn(async (input: { userId: string; count?: number; reason?: string }) => {
    pushes.push({ userId: input.userId, count: input.count, reason: input.reason });
  }),
}));

let mongo: MongoMemoryServer;
let app: typeof import("../src/app.js")["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let CrmLead: typeof import("../src/models/crmLead.model.js")["default"];
let CrmLeadMove: typeof import("../src/models/crmLeadMove.model.js")["default"];
let CrmTaskTransferRequest: typeof import("../src/models/crmTaskTransfer.model.js")["default"];
let admin: any;
let tanner: any;
let riley: any;

const bearer = (user: any) => `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET!, { expiresIn: "30m" })}`;

async function makeUser(extra: Record<string, unknown> = {}) {
  const id = new mongoose.Types.ObjectId();
  return User.create({
    _id: id, username: `User ${id}`, email: `${id}@example.test`, password: "test-password",
    authProvider: "email", isVerified: true, role: "user", isCrmAgent: true, ...extra,
  });
}

async function makeLead(owner: any, extra: Record<string, unknown> = {}) {
  return CrmLead.create({
    clientName: "Prairie contact", companyName: "Prairie Ltd", companyLocation: "Winnipeg, MB",
    assignedTo: owner._id, assignedBy: admin._id, status: "contacted", notes: "Keep these notes",
    leadGeo: { city: "Winnipeg", regionCode: "MB", countryCode: "CA" }, assignmentMatchedRegion: "CA-MB",
    updates: [{ comment: "Called once", status: "contacted", createdBy: owner._id, createdAt: new Date("2026-10-01T12:00:00Z") }],
    ...extra,
  });
}

const api = () => request(app);
const asAdmin = (req: request.Test) => req.set("Authorization", bearer(admin));

beforeAll(async () => {
  vi.stubEnv("RESEND_API_KEY", "re_crm_move_test_only");
  vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: CrmLead } = await import("../src/models/crmLead.model.js"));
  ({ default: CrmLeadMove } = await import("../src/models/crmLeadMove.model.js"));
  ({ default: CrmTaskTransferRequest } = await import("../src/models/crmTaskTransfer.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  emails.length = 0;
  pushes.length = 0;
  admin = await makeUser({ role: "admin", isCrmAgent: false, username: "Femi" });
  tanner = await makeUser({ username: "Tanner" });
  riley = await makeUser({ username: "Riley" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  vi.unstubAllEnvs();
});

async function createPool(name = "Winnipeg") {
  const response = await asAdmin(api().post("/api/crm/admin/vacant-pools")).send({ name });
  expect(response.status).toBe(200);
  return response.body as { id: string; name: string; label: string };
}

describe.sequential("vacant pools", () => {
  it("are a blocked, non-agent placeholder that cannot sign in, one per name", async () => {
    const pool = await createPool();
    expect(pool.label).toBe("Vacant — Winnipeg");
    const stored = await User.findById(pool.id).lean();
    expect(stored).toMatchObject({ crmVacantPool: true, crmVacantPoolName: "Winnipeg", isBlocked: true, isCrmAgent: false, role: "user", isVerified: false });
    expect(String(stored?.email)).toMatch(/@vacant-pool\.invalid$/);
    const login = await api().post("/api/auth/login").send({ email: stored?.email, password: "anything-at-all" });
    expect(login.status).not.toBe(200);
    const again = await asAdmin(api().post("/api/crm/admin/vacant-pools")).send({ name: "winnipeg" });
    expect(again.status).toBe(409);
    expect((await asAdmin(api().post("/api/crm/admin/vacant-pools")).send({ name: " " })).status).toBe(400);
  });

  it("never become an agent, are never unblocked or edited as a user, and are left out of user lists and transfer targets", async () => {
    const pool = await createPool();
    expect((await asAdmin(api().patch(`/api/crm/admin/users/${pool.id}/agent`)).send({ isCrmAgent: true })).status).toBe(403);
    expect((await asAdmin(api().patch(`/api/admin/users/${pool.id}/block`)).send({ blocked: false })).status).toBe(403);
    expect((await asAdmin(api().patch(`/api/admin/users/${pool.id}/profile`)).send({ isCrmAgent: true })).status).toBe(403);
    const crmUsers = await asAdmin(api().get("/api/crm/admin/users?limit=200"));
    expect(crmUsers.body.items.map((u: any) => String(u._id))).not.toContain(pool.id);
    const adminUsers = await asAdmin(api().get("/api/admin/users?limit=100"));
    expect(adminUsers.body.items.map((u: any) => String(u._id))).not.toContain(pool.id);
    const transferAgents = await api().get("/api/crm/tasks/transfer/agents").set("Authorization", bearer(tanner));
    expect(JSON.stringify(transferAgents.body)).not.toContain(pool.id);
    const stored = await User.findById(pool.id).lean();
    expect(stored).toMatchObject({ isBlocked: true, isCrmAgent: false });
  });
});

describe.sequential("moving leads", () => {
  it("lists every owner with lead counts, agents first, then pools", async () => {
    const pool = await createPool();
    await makeLead(tanner);
    await makeLead(tanner, { status: "won" });
    const response = await asAdmin(api().get("/api/crm/admin/leads/move/owners"));
    expect(response.status).toBe(200);
    const byId = new Map(response.body.items.map((o: any) => [o.id, o]));
    expect(byId.get(String(tanner._id))).toMatchObject({ label: "Tanner", kind: "agent", total: 2, open: 1 });
    expect(byId.get(pool.id)).toMatchObject({ label: "Vacant — Winnipeg", kind: "pool", total: 0, open: 0 });
    expect(byId.has(String(admin._id))).toBe(false);
  });

  it("previews, then parks Tanner's open Winnipeg leads in the pool, and keeps everything else", async () => {
    const pool = await createPool();
    const winnipegOpen = await Promise.all([1, 2, 3].map(() => makeLead(tanner)));
    const winnipegWon = await makeLead(tanner, { status: "won" });
    const edmonton = await makeLead(tanner, { companyLocation: "Edmonton, AB", leadGeo: { city: "Edmonton" }, assignmentMatchedRegion: "CA-AB" });
    const beingDeleted = await makeLead(tanner);
    await CrmLead.collection.updateOne({ _id: beingDeleted._id }, { $set: { crmDeletionToken: "deleting" } });
    const transfer = await CrmTaskTransferRequest.create({ leadId: winnipegOpen[0]._id, fromUserId: tanner._id, toUserId: riley._id, requestedBy: tanner._id, status: "pending" });
    const filters = { openOnly: true, city: "Winnipeg" };

    const preview = await asAdmin(api().post("/api/crm/admin/leads/move/preview")).send({ fromUserId: String(tanner._id), filters });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ count: 3, from: { label: "Tanner", kind: "agent" } });
    expect(preview.body.byStatus).toEqual([{ value: "contacted", count: 3 }]);
    expect(await CrmLead.countDocuments({ assignedTo: pool.id })).toBe(0);

    const move = await asAdmin(api().post("/api/crm/admin/leads/move")).send({ fromUserId: String(tanner._id), toUserId: pool.id, filters });
    expect(move.status).toBe(200);
    expect(move.body).toMatchObject({ movedCount: 3, from: "Tanner", to: "Vacant — Winnipeg" });

    for (const lead of winnipegOpen) {
      const moved = await CrmLead.findById(lead._id).lean();
      expect(String(moved?.assignedTo)).toBe(pool.id);
      expect(moved).toMatchObject({ assignmentMethod: "admin_bulk_move", assignmentReason: "Moved from Tanner to Vacant — Winnipeg by admin", status: "contacted", notes: "Keep these notes" });
      expect(String(moved?.assignedBy)).toBe(String(admin._id));
      expect(moved?.updates).toHaveLength(1);
    }
    for (const kept of [winnipegWon, edmonton, beingDeleted]) {
      expect(String((await CrmLead.findById(kept._id).lean())?.assignedTo)).toBe(String(tanner._id));
    }
    expect((await CrmTaskTransferRequest.findById(transfer._id).lean())?.status).toBe("cancelled");
    const record = await CrmLeadMove.findById(move.body.moveId).lean();
    expect(record).toMatchObject({ fromLabel: "Tanner", toLabel: "Vacant — Winnipeg", count: 3, filters: { openOnly: true, city: "Winnipeg" } });
    expect(record?.leadIds.map(String).sort()).toEqual(winnipegOpen.map((l) => String(l._id)).sort());
    // A pool is not told anything.
    expect(emails).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it("hands the pool to the new salesperson in one step, with one email and one push for the lot", async () => {
    const pool = await createPool();
    await Promise.all([1, 2, 3, 4].map(() => makeLead(tanner)));
    await asAdmin(api().post("/api/crm/admin/leads/move")).send({ fromUserId: String(tanner._id), toUserId: pool.id, filters: {} }).expect(200);
    const handOver = await asAdmin(api().post("/api/crm/admin/leads/move")).send({ fromUserId: pool.id, toUserId: String(riley._id), filters: {} });
    expect(handOver.status).toBe(200);
    expect(handOver.body).toMatchObject({ movedCount: 4, from: "Vacant — Winnipeg", to: "Riley" });
    expect(await CrmLead.countDocuments({ assignedTo: riley._id })).toBe(4);
    expect(emails).toEqual([{ to: riley.email, tasks: 4, total: 4 }]);
    expect(pushes).toEqual([{ userId: String(riley._id), count: 4, reason: "reassignment" }]);
    // Riley now sees them as his own tasks.
    const mine = await api().get("/api/crm/tasks/my?view=summary&status=all").set("Authorization", bearer(riley));
    expect(mine.body.total).toBe(4);
    const moves = await asAdmin(api().get("/api/crm/admin/leads/moves"));
    expect(moves.body.items.map((m: any) => `${m.from} → ${m.to} (${m.count})`)).toEqual(["Vacant — Winnipeg → Riley (4)", "Tanner → Vacant — Winnipeg (4)"]);
  });

  it("refuses a move to someone who is neither an active agent nor a pool, to the same owner, or with nothing to move", async () => {
    await makeLead(tanner);
    const blocked = await makeUser({ username: "Gone", isBlocked: true });
    const notAgent = await makeUser({ username: "Bidder", isCrmAgent: false });
    for (const target of [blocked, notAgent, admin]) {
      const response = await asAdmin(api().post("/api/crm/admin/leads/move")).send({ fromUserId: String(tanner._id), toUserId: String(target._id), filters: {} });
      expect(response.status).toBe(400);
    }
    expect((await asAdmin(api().post("/api/crm/admin/leads/move")).send({ fromUserId: String(tanner._id), toUserId: String(tanner._id), filters: {} })).status).toBe(400);
    const none = await asAdmin(api().post("/api/crm/admin/leads/move")).send({ fromUserId: String(tanner._id), toUserId: String(riley._id), filters: { city: "Halifax" } });
    expect(none.status).toBe(400);
    expect(none.body.message).toMatch(/No leads match/);
    expect(await CrmLead.countDocuments({ assignedTo: tanner._id })).toBe(1);
  });

  it("is for admins only", async () => {
    await makeLead(tanner);
    for (const [method, path] of [["get", "/api/crm/admin/leads/move/owners"], ["post", "/api/crm/admin/leads/move"], ["post", "/api/crm/admin/vacant-pools"], ["post", "/api/crm/admin/leads/move/preview"]] as const) {
      const response = await (api() as any)[method](path).set("Authorization", bearer(tanner)).send({ fromUserId: String(tanner._id), toUserId: String(riley._id), filters: {}, name: "X" });
      expect([401, 403]).toContain(response.status);
    }
    expect(await CrmLead.countDocuments({ assignedTo: tanner._id })).toBe(1);
  });
});
