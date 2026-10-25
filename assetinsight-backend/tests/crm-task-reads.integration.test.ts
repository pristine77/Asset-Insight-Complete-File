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

async function makeLead(extra: Record<string, unknown> = {}, updateCount = 127) {
  return CrmLead.create({
    clientName: "Northstar contact", companyName: "Northstar Ltd", email: "contact@example.test",
    phoneRaw: "204-555-0100", companyLocation: "Regina", companyDescription: "Equipment supplier",
    contactLocation: "Saskatchewan", category: "Farm equipment", specialization: "farm_equipment_sales",
    contactPhones: ["204-555-0199"], notes: "Private detail notes", latestComment: "Latest activity",
    importData: { sourceColumn: "x".repeat(300_000) }, latestAttachmentUrls: ["https://files.example.test/latest.pdf"],
    latestRecordingUrl: "https://files.example.test/recording.webm", assignedTo: owner._id, assignedBy: other._id,
    status: "contacted", leadSource: "organic", taskStartDate: new Date("2026-08-01T12:00:00Z"),
    statusChangedAt: new Date("2026-08-01T12:00:00Z"), dueDate: new Date("2026-08-08T12:00:00Z"),
    updates: Array.from({ length: updateCount }, (_, i) => ({
      _id: new mongoose.Types.ObjectId((i + 1).toString(16).padStart(24, "0")),
      comment: i === 11 ? undefined : `Update ${i}`,
      status: "contacted", createdBy: i % 2 ? other._id : owner._id,
      createdAt: new Date(Date.UTC(2026, 7, 1, 12, 0, Math.floor(i / 2))),
      isDeleted: i === 11, deletedAt: i === 11 ? new Date("2026-08-02T12:00:00Z") : undefined,
      attachmentUrls: i === 11 ? [] : [`https://files.example.test/${i}.pdf`],
      recordingUrl: i === 10 ? "https://files.example.test/ten.webm" : undefined,
      editedAt: i === 10 ? new Date("2026-08-02T12:00:00Z") : undefined,
    })),
    ...extra,
  });
}

beforeAll(async () => {
  vi.stubEnv("RESEND_API_KEY", "re_crm_reads_test_only");
  vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: CrmLead } = await import("../src/models/crmLead.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  owner = await makeUser();
  other = await makeUser();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  vi.unstubAllEnvs();
});

describe.sequential("bounded CRM agent task reads", () => {
  it("projects compact list rows with accurate counts before materialization, without saving partial records", async () => {
    const lead = await makeLead();
    const before = await CrmLead.collection.findOne({ _id: lead._id });
    const response = await request(app).get("/api/crm/tasks/my?view=summary&status=all").set("Authorization", authorization());
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ total: 1, page: 1, limit: 20, statusCounts: [{ _id: "contacted", count: 1 }], leadSourceCounts: { total: 1, organic: 1, generic: 0 } });
    expect(response.body.items[0]).toMatchObject({ _id: String(lead._id), clientName: "Northstar contact", updateCount: 127, assignedTo: String(owner._id), assignedBy: { _id: String(other._id), email: other.email }, latestComment: "Latest activity" });
    for (const field of ["updates", "importData", "latestAttachmentUrls", "latestRecordingUrl", "notes", "companyDescription", "contactPhones", "companyLocation", "category", "specialization", "listItems"]) expect(response.body.items[0]).not.toHaveProperty(field);
    expect(Buffer.byteLength(JSON.stringify(response.body))).toBeLessThan(8_000);
    expect(await CrmLead.collection.findOne({ _id: lead._id })).toEqual(before);
  });

  it("retains full legacy list shape/history when summary is not requested", async () => {
    await makeLead();
    const legacy = await request(app).get("/api/crm/tasks/my?status=all").set("Authorization", authorization());
    expect(legacy.status).toBe(200);
    expect(legacy.body.items[0].updates).toHaveLength(127);
    expect(legacy.body.items[0].updates[0].createdBy).toMatchObject({ _id: String(owner._id), role: "user" });
    expect(legacy.body.items[0].importData.sourceColumn).toHaveLength(300_000);
    expect(legacy.body.items[0].latestAttachmentUrls).toEqual(["https://files.example.test/latest.pdf"]);
    expect(legacy.body.items[0]).not.toHaveProperty("updateCount");
    const unknownView = await request(app).get("/api/crm/tasks/my?status=all&view=legacy").set("Authorization", authorization());
    expect(unknownView.body).toEqual(legacy.body);
  });

  it("preserves existing search, source, status and pagination scopes for summary queries", async () => {
    await makeLead({ clientName: "Target A", dueDate: new Date("2026-08-09T12:00:00Z") }, 1);
    await makeLead({ clientName: "Target B", dueDate: new Date("2026-08-10T12:00:00Z") }, 2);
    await makeLead({ clientName: "Target C", status: "won" }, 0);
    await makeLead({ clientName: "Target foreign", assignedTo: other._id }, 1);
    const query = "q=Target&status=contacted&leadSource=organic&page=2&limit=1";
    const legacy = await request(app).get(`/api/crm/tasks/my?${query}`).set("Authorization", authorization());
    const summary = await request(app).get(`/api/crm/tasks/my?${query}&view=summary`).set("Authorization", authorization());
    expect(summary.status).toBe(200);
    expect(summary.body.items[0]).toMatchObject({ _id: legacy.body.items[0]._id, clientName: "Target B", updateCount: 2 });
    for (const key of ["total", "page", "limit", "statusCounts", "leadSourceCounts"]) expect(summary.body[key]).toEqual(legacy.body[key]);
    expect(summary.body.total).toBe(2);
  });

  it("returns complete contact/import/current-media detail while excluding history", async () => {
    const lead = await makeLead();
    const before = await CrmLead.collection.findOne({ _id: lead._id });
    const response = await request(app).get(`/api/crm/tasks/${lead._id}`).set("Authorization", authorization());
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.item).toMatchObject({ updateCount: 127, assignedTo: { _id: String(owner._id), role: "user" }, companyDescription: "Equipment supplier", contactLocation: "Saskatchewan", latestAttachmentUrls: ["https://files.example.test/latest.pdf"], latestRecordingUrl: "https://files.example.test/recording.webm" });
    expect(response.body.item.importData.sourceColumn).toHaveLength(300_000);
    expect(response.body.item).not.toHaveProperty("updates");
    expect(response.body.item.assignedTo).not.toHaveProperty("password");
    expect(await CrmLead.collection.findOne({ _id: lead._id })).toEqual(before);
  });

  it("pages history newest first, breaks timestamp ties, and preserves authors, tombstones and media fields", async () => {
    const lead = await makeLead();
    const before = await CrmLead.collection.findOne({ _id: lead._id });
    const pages = [];
    for (let page = 1; page <= 3; page++) {
      const response = await request(app).get(`/api/crm/tasks/${lead._id}/updates?page=${page}&limit=50`).set("Authorization", authorization());
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toMatchObject({ total: 127, page, limit: 50 });
      expect(response.body.items).toHaveLength(page === 3 ? 27 : 50);
      pages.push(...response.body.items);
    }
    expect(pages.map(item => item._id)).toEqual(Array.from({ length: 127 }, (_, i) => (127 - i).toString(16).padStart(24, "0")));
    expect(pages[0].createdBy).toMatchObject({ _id: String(owner._id), email: owner.email, role: "user" });
    expect(pages.find(item => item._id === "00000000000000000000000c")).toMatchObject({ isDeleted: true, deletedAt: "2026-08-02T12:00:00.000Z", attachmentUrls: [] });
    expect(pages.find(item => item._id === "00000000000000000000000b")).toMatchObject({ comment: "Update 10", editedAt: "2026-08-02T12:00:00.000Z", attachmentUrls: ["https://files.example.test/10.pdf"], recordingUrl: "https://files.example.test/ten.webm" });
    expect(await CrmLead.collection.findOne({ _id: lead._id })).toEqual(before);
    const pastEnd = await request(app).get(`/api/crm/tasks/${lead._id}/updates?page=4&limit=50`).set("Authorization", authorization());
    expect(pastEnd.body).toEqual({ items: [], total: 127, page: 4, limit: 50 });
  });

  it("returns zero history and correct default paging for an empty task", async () => {
    const lead = await makeLead({}, 0);
    const history = await request(app).get(`/api/crm/tasks/${lead._id}/updates`).set("Authorization", authorization());
    expect(history.body).toEqual({ items: [], total: 0, page: 1, limit: 20 });
    const detail = await request(app).get(`/api/crm/tasks/${lead._id}`).set("Authorization", authorization());
    expect(detail.body.item.updateCount).toBe(0);
  });

  it("normalizes legacy presentation without persisting the bounded projection", async () => {
    const id = new mongoose.Types.ObjectId();
    await CrmLead.collection.insertOne({ _id: id, assignedTo: owner._id, assignedBy: other._id, clientName: "Legacy", status: "no_answer", phoneRaw: "Pending", companyPhones: ["204-555-0100"], createdAt: new Date("2026-08-01T12:00:00Z"), updates: [{ _id: new mongoose.Types.ObjectId(), status: "completed", createdBy: owner._id }] } as any);
    const before = await CrmLead.collection.findOne({ _id: id });
    const detail = await request(app).get(`/api/crm/tasks/${id}`).set("Authorization", authorization());
    expect(detail.body.item).toMatchObject({ status: "contacted", phoneFormatted: "+1 (204) 555-0100", updateCount: 1 });
    const history = await request(app).get(`/api/crm/tasks/${id}/updates`).set("Authorization", authorization());
    expect(history.body.items[0]).toMatchObject({ status: "won", isDeleted: false, attachmentUrls: [] });
    expect(await CrmLead.collection.findOne({ _id: id })).toEqual(before);
  });

  it("does not expose foreign/missing tasks and rechecks ownership after reassignment", async () => {
    const lead = await makeLead();
    for (const id of [lead._id, new mongoose.Types.ObjectId()]) {
      for (const suffix of ["", "/updates"]) {
        const response = await request(app).get(`/api/crm/tasks/${id}${suffix}`).set("Authorization", authorization(other));
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ message: "CRM task not found" });
      }
    }
    await CrmLead.updateOne({ _id: lead._id }, { $set: { assignedTo: other._id } });
    for (const suffix of ["", "/updates"]) expect((await request(app).get(`/api/crm/tasks/${lead._id}${suffix}`).set("Authorization", authorization())).status).toBe(404);
  });

  it.each(["disabled", "blocked", "admin", "unauthenticated"])("enforces current CRM/auth permission for %s callers", async mode => {
    const lead = await makeLead();
    if (mode === "disabled") await User.updateOne({ _id: owner._id }, { $set: { isCrmAgent: false } });
    if (mode === "blocked") await User.updateOne({ _id: owner._id }, { $set: { isBlocked: true } });
    if (mode === "admin") await User.updateOne({ _id: owner._id }, { $set: { isCrmAgent: false, role: "superadmin" } });
    for (const path of ["my?view=summary", String(lead._id), `${lead._id}/updates`]) {
      let call = request(app).get(`/api/crm/tasks/${path}`);
      if (mode !== "unauthenticated") call = call.set("Authorization", authorization());
      const response = await call;
      expect(response.status).toBe(mode === "unauthenticated" ? 401 : 403);
      expect(response.body).not.toHaveProperty("items");
      expect(response.body).not.toHaveProperty("item");
    }
  });

  it.each(["bad-id", "123456789012", "zzzzzzzzzzzzzzzzzzzzzzzz"])("rejects malformed detail/history id %s", async id => {
    for (const suffix of ["", "/updates"]) expect((await request(app).get(`/api/crm/tasks/${id}${suffix}`).set("Authorization", authorization())).status).toBe(400);
  });

  it("keeps device enforcement on every bounded agent read", async () => {
    const lead = await makeLead({}, 0);
    vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "on");
    try {
      for (const path of ["my?view=summary", String(lead._id), `${lead._id}/updates`]) {
        const response = await request(app).get(`/api/crm/tasks/${path}`).set("Authorization", authorization());
        expect(response.status).toBe(401);
        expect(response.body.code).toBe("DEVICE_CONTEXT_REQUIRED");
      }
    } finally {
      vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
    }
  });

  it.each(["page=0", "page=-1", "page=1.5", "page=abc", "page=9007199254740992", "limit=0", "limit=51", "limit=2x", "page=1&page=2"])("rejects invalid history pagination %s", async query => {
    const lead = await makeLead({}, 0);
    const response = await request(app).get(`/api/crm/tasks/${lead._id}/updates?${query}`).set("Authorization", authorization());
    expect(response.status).toBe(400);
  });

  it("keeps specific agent/transfer routes ahead of the detail route", async () => {
    expect((await request(app).get("/api/crm/tasks/transfer/agents").set("Authorization", authorization())).status).toBe(200);
    const transfers = await request(app).get("/api/crm/tasks/transfers/my").set("Authorization", authorization());
    expect(transfers.status).toBe(200);
    expect(transfers.body).toEqual({ items: [] });
  });
});
