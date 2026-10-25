import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => { const config = () => ({ parsed: {} }); return { config, default: { config } }; });
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
vi.mock("../src/service/notificationService.js", () => ({ notifyUser: vi.fn(async () => undefined) }));
vi.mock("../src/service/crmPushService.js", () => ({ sendCrmNewTaskNotification: vi.fn(async () => undefined), sendCrmAdminMessageNotification: vi.fn(async () => undefined) }));
vi.mock("../src/service/crmEmailService.js", () => ({ sendCrmAgentAssignedEmail: vi.fn(async () => undefined), sendCrmTasksAssignedEmail: vi.fn(async () => undefined) }));

let mongo: MongoMemoryServer;
let app: typeof import("../src/app.js")["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let Lead: typeof import("../src/models/crmLead.model.js")["default"];
let Transfer: typeof import("../src/models/crmTaskTransfer.model.js")["default"];
let createApiKey: typeof import("../src/service/apiKeyService.js")["createApiKey"];
let reviewer: any, reviewPeer: any, ordinary: any, ordinaryPeer: any, admin: any;
const auth = (user: any) => `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET!, { expiresIn: "30m" })}`;
async function user(extra: Record<string, unknown> = {}) {
  const id = new mongoose.Types.ObjectId();
  return User.create({ _id: id, username: `Agent ${id}`, email: `${id}@example.test`, password: "test-password", authProvider: "email", isVerified: true, role: "user", isCrmAgent: true, ...extra });
}
async function lead(owner: any, review: boolean, extra: Record<string, unknown> = {}) {
  return Lead.create({ clientName: review ? "Synthetic Review Fixture" : "Private Production Fixture", assignedTo: owner._id, assignedBy: owner._id, isReviewData: review, status: "new_lead", leadSource: "organic", taskStartDate: new Date(), ...extra });
}
beforeAll(async () => {
  vi.stubEnv("RESEND_API_KEY", "re_crm_review_test_only");
  vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: Lead } = await import("../src/models/crmLead.model.js"));
  ({ default: Transfer } = await import("../src/models/crmTaskTransfer.model.js"));
  ({ createApiKey } = await import("../src/service/apiKeyService.js"));
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  reviewer = await user({ isReviewAccount: true });
  reviewPeer = await user({ isReviewAccount: true });
  ordinary = await user();
  ordinaryPeer = await user();
  admin = await user({ role: "superadmin", isCrmAgent: false });
  vi.clearAllMocks();
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); vi.unstubAllEnvs(); });

describe.sequential("CRM isolated review identity", () => {
  it("keeps both agent directories inside their cohort", async () => {
    for (const [actor, expected] of [[reviewer, reviewPeer], [ordinary, ordinaryPeer]]) {
      const res = await request(app).get("/api/crm/tasks/transfer/agents").set("Authorization", auth(actor));
      expect(res.status).toBe(200);
      expect(res.body.items.map((item: any) => item._id)).toEqual([String(expected._id)]);
    }
  });
  it("derives synthetic provenance from the actor, ignores client markers and blocks admin assignment to reviewer", async () => {
    const body = { name: "Review Fixture", phone: "204-555-0100", category: "Farm equipment", specialization: "farm_equipment_sales", isReviewData: false, isReviewAccount: false };
    const own = await request(app).post("/api/crm/tasks/quick-add").set("Authorization", auth(reviewer)).send(body);
    expect(own.status).toBe(201);
    expect((await Lead.findById(own.body.item._id))?.isReviewData).toBe(true);
    const normal = await request(app).post("/api/crm/tasks/quick-add").set("Authorization", auth(ordinary)).send({ ...body, isReviewData: true });
    expect(normal.status).toBe(201);
    expect((await Lead.findById(normal.body.item._id))?.isReviewData).toBe(false);
    const direct = await request(app).post("/api/crm/admin/leads/quick-add").set("Authorization", auth(admin)).send({ ...body, assignedTo: String(reviewer._id) });
    expect(direct.status).toBe(400);
    expect(await Lead.countDocuments()).toBe(2);
  });
  it("does not read or modify a real lead accidentally assigned to reviewer, or synthetic lead assigned to normal user", async () => {
    for (const [actor, review] of [[reviewer, true], [ordinary, false]] as const) {
      const allowed = await lead(actor, review);
      const forbidden = await lead(actor, !review);
      const before = await Lead.collection.findOne({ _id: forbidden._id });
      for (const path of ["/tasks/my?status=all", "/tasks/my?status=all&view=summary", "/tasks/dashboard"]) {
        const res = await request(app).get(`/api/crm${path}`).set("Authorization", auth(actor));
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        if (res.body.items) expect(res.body.items.map((item: any) => item._id)).toEqual([String(allowed._id)]);
      }
      for (const suffix of ["", "/updates"]) {
        expect((await request(app).get(`/api/crm/tasks/${forbidden._id}${suffix}`).set("Authorization", auth(actor))).status).toBe(404);
      }
      const mutation = await request(app).patch(`/api/crm/tasks/${forbidden._id}/update`).set("Authorization", auth(actor)).send({ comment: "Must not mutate" });
      expect(mutation.status).toBe(404);
      expect(await Lead.collection.findOne({ _id: forbidden._id })).toEqual(before);
    }
  });
  it("refuses transfers across cohorts before any request or notification is created", async () => {
    const { notifyUser } = await import("../src/service/notificationService.js");
    for (const [from, to, review] of [[reviewer, ordinary, true], [ordinary, reviewer, false]] as const) {
      const owned = await lead(from, review);
      const res = await request(app).post(`/api/crm/tasks/${owned._id}/transfer`).set("Authorization", auth(from)).send({ toUserId: String(to._id) });
      expect(res.status).toBe(404);
    }
    expect(await Transfer.countDocuments()).toBe(0);
    expect(notifyUser).not.toHaveBeenCalled();
  });
  it.each([true, false])("preserves same-cohort transfer and acceptance (review=%s)", async (review) => {
    const from = review ? reviewer : ordinary;
    const to = review ? reviewPeer : ordinaryPeer;
    const owned = await lead(from, review);
    const res = await request(app).post(`/api/crm/tasks/${owned._id}/transfer`).set("Authorization", auth(from)).send({ toUserId: String(to._id) });
    expect(res.status).toBe(201);
    expect((await Transfer.findById(res.body.item._id))?.isReviewData).toBe(review);
    const inbox = await request(app).get("/api/crm/tasks/transfers/my").set("Authorization", auth(to));
    expect(inbox.status).toBe(200);
    expect(inbox.body.items).toHaveLength(1);
    const accepted = await request(app).patch(`/api/crm/tasks/transfers/${res.body.item._id}`).set("Authorization", auth(to)).send({ action: "accept" });
    expect(accepted.status).toBe(200);
    expect(String((await Lead.findById(owned._id))?.assignedTo)).toBe(String(to._id));
  });
  it("hides and refuses a pre-existing cross-cohort transfer without changing customer work", async () => {
    const real = await lead(ordinary, false);
    const bad = await Transfer.create({ leadId: real._id, fromUserId: ordinary._id, toUserId: reviewer._id, requestedBy: ordinary._id, status: "pending" });
    const inbox = await request(app).get("/api/crm/tasks/transfers/my").set("Authorization", auth(reviewer));
    expect(inbox.body.items).toEqual([]);
    const accepted = await request(app).patch(`/api/crm/tasks/transfers/${bad._id}`).set("Authorization", auth(reviewer)).send({ action: "accept" });
    expect(accepted.status).toBe(404);
    expect(String((await Lead.findById(real._id))?.assignedTo)).toBe(String(ordinary._id));
    expect((await Transfer.findById(bad._id))?.status).toBe("pending");
  });
  it("rechecks current sender cohort before accepting a stale transfer", async () => {
    const synthetic = await lead(reviewer, true);
    const bad = await Transfer.create({ isReviewData: true, leadId: synthetic._id, fromUserId: ordinary._id, toUserId: reviewPeer._id, requestedBy: ordinary._id, status: "pending" });
    for (const status of ["pending", "cancelled"]) {
      const inbox = await request(app).get(`/api/crm/tasks/transfers/my?status=${status}`).set("Authorization", auth(reviewPeer));
      expect(inbox.status).toBe(200);
      expect(inbox.body.items).toEqual([]);
    }
    const accepted = await request(app).patch(`/api/crm/tasks/transfers/${bad._id}`).set("Authorization", auth(reviewPeer)).send({ action: "accept" });
    expect(accepted.status).toBe(404);
    expect(String((await Lead.findById(synthetic._id))?.assignedTo)).toBe(String(reviewer._id));
  });
  it("blocks explicit admin reassignment of production import rows to review identities", async () => {
    const real = await lead(ordinary, false, { sourceBatchId: "production-fixture" });
    const res = await request(app).patch("/api/crm/admin/assignments-by-upload/production-fixture/reassign").set("Authorization", auth(admin)).send({ assignments: [{ leadId: String(real._id), assignedTo: String(reviewer._id) }] });
    expect(res.status).toBe(400);
    expect(String((await Lead.findById(real._id))?.assignedTo)).toBe(String(ordinary._id));
  });
  it("rejects explicit reviewer import destinations before storage or queue creation, including mixed selections", async () => {
    for (const ids of [[String(reviewer._id)], [String(ordinary._id), String(reviewer._id)]]) {
      const res = await request(app).post("/api/crm/admin/leads/import").set("Authorization", auth(admin))
        .field("assignedToUserIds", JSON.stringify(ids))
        .attach("file", Buffer.from("Client Name,Company Name,Email\nFixture,Fixture Ltd,fixture@example.test\n"), { filename: "review-fixture.csv", contentType: "text/csv" });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Review accounts cannot receive production CRM imports");
    }
    expect(await Lead.countDocuments()).toBe(0);
    expect(await mongoose.connection.db!.collection("crmimportjobs").countDocuments()).toBe(0);
  });
  it("rechecks the same reviewer exclusion when an older durable import job starts", async () => {
    const { runDurableCrmImportJob } = await import("../src/controller/crm.controller.js");
    await expect(runDurableCrmImportJob({ payload: { jobId: "review-isolation-fixture", sourceBatchId: "review-fixture", sourceFileKey: "fixtures/not-a-real-file.csv", sourceFileName: "fixture.csv", selectedUserIds: [String(ordinary._id), String(reviewer._id)] } } as any)).rejects.toThrow("Review accounts cannot receive production CRM imports");
    expect(await Lead.countDocuments()).toBe(0);
  });
  it("does not expose production staff identities through synthetic history or detail population", async () => {
    const own = await lead(reviewer, true, { assignedBy: ordinary._id, updates: [{ comment: "Synthetic fixture note", status: "new_lead", createdBy: ordinary._id }] });
    for (const path of ["/tasks/my?status=all", "/tasks/my?view=summary&status=all", `/tasks/${own._id}`, `/tasks/${own._id}/updates`]) {
      const res = await request(app).get(`/api/crm${path}`).set("Authorization", auth(reviewer));
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(ordinary.email);
    }
    const unchanged = await Lead.findById(own._id).lean();
    expect(String(unchanged?.assignedBy)).toBe(String(ordinary._id));
    expect(String((unchanged?.updates as any[])?.[0]?.createdBy)).toBe(String(ordinary._id));
  });
  it("keeps server data markers immutable across normal document edits", async () => {
    const own = await lead(reviewer, true);
    await Lead.updateOne({ _id: own._id }, { $set: { isReviewData: false, notes: "Still synthetic" } });
    expect((await Lead.findById(own._id))?.isReviewData).toBe(true);
    const transfer = await Transfer.create({ isReviewData: true, leadId: own._id, fromUserId: reviewer._id, toUserId: reviewPeer._id, requestedBy: reviewer._id });
    await Transfer.updateOne({ _id: transfer._id }, { $set: { isReviewData: false, note: "Still synthetic" } });
    expect((await Transfer.findById(transfer._id))?.isReviewData).toBe(true);
  });
  it("never exposes synthetic CRM through partner API list/detail/reply", async () => {
    const synthetic = await lead(reviewer, true);
    const real = await lead(ordinary, false);
    const { rawKey } = await createApiKey({ name: "isolation fixture", createdBy: String(admin._id) });
    const list = await request(app).get("/api/v1/crm/leads").set("X-API-Key", rawKey);
    expect(list.status).toBe(200);
    expect(list.body.data.map((item: any) => item._id)).toEqual([String(real._id)]);
    expect((await request(app).get(`/api/v1/crm/leads/${synthetic._id}`).set("X-API-Key", rawKey)).status).toBe(404);
    expect((await request(app).post(`/api/v1/crm/leads/${synthetic._id}/reply`).set("X-API-Key", rawKey).send({ comment: "Must not write" })).status).toBe(404);
    expect((await Lead.findById(synthetic._id))?.updates).toHaveLength(0);
  });
});
