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

async function makeLead(extra: Record<string, unknown> = {}) {
  return CrmLead.create({
    clientName: "Rick's Wrecker Service", companyName: "Rick's Automotive", email: "old@example.test",
    phoneRaw: "817-558-2523", phoneFormatted: "+1 (817) 558-2523", companyLocation: "1110 North Main St., Cleburne, TX",
    website: "https://old.example.test", notes: "Old notes", category: "Towing", specialization: "auto_dealers",
    identityKey: "email:old@example.test", dedupeFingerprints: ["email:old@example.test::towing"],
    assignedTo: owner._id, assignedBy: other._id, status: "contacted", leadSource: "organic",
    updates: [{ comment: "Called, left voicemail", status: "contacted", createdBy: owner._id, createdAt: new Date("2026-10-01T12:00:00Z") }],
    ...extra,
  });
}

function editContact(lead: any, body: unknown, user = owner) {
  return request(app).patch(`/api/crm/tasks/${lead._id}/contact`).set("Authorization", authorization(user)).send(body as object);
}

beforeAll(async () => {
  vi.stubEnv("RESEND_API_KEY", "re_crm_contact_edit_test_only");
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

describe.sequential("CRM contact edits by the assigned agent", () => {
  it("saves every edited field, records one history entry and keeps status and import identity", async () => {
    const lead = await makeLead();
    const response = await editContact(lead, {
      clientName: "Rick Argo", companyName: "Rick's Towing", phone: "(204) 555-0142", email: "Rick@Example.TEST",
      address: "22 Main St, Winnipeg, MB", website: "ricks-towing.example.test", notes: "Prefers mornings",
    });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Contact details saved");
    const saved: any = await CrmLead.findById(lead._id).lean();
    expect(saved).toMatchObject({
      clientName: "Rick Argo", companyName: "Rick's Towing", phoneFormatted: "+1 (204) 555-0142", email: "rick@example.test",
      companyLocation: "22 Main St, Winnipeg, MB", website: "ricks-towing.example.test",
      companyWebsiteDomain: "ricks-towing.example.test", notes: "Prefers mornings", status: "contacted",
      identityKey: "email:old@example.test", dedupeFingerprints: ["email:old@example.test::towing"],
    });
    expect(String(saved.assignedTo)).toBe(String(owner._id));
    expect(saved.updates).toHaveLength(2);
    expect(saved.updates[1]).toMatchObject({
      comment: "Contact details edited: name, company, email, phone, address, website, notes", status: "contacted",
    });
    expect(String(saved.updates[1].createdBy)).toBe(String(owner._id));
    expect(saved.latestComment).toBe("Contact details edited: name, company, email, phone, address, website, notes");
    expect(response.body.item.clientName).toBe("Rick Argo");
  });

  it("adds no history entry when nothing changed", async () => {
    const lead = await makeLead();
    const response = await editContact(lead, { clientName: " Rick's Wrecker Service ", website: "https://old.example.test" });
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("No contact changes");
    expect((await CrmLead.findById(lead._id).lean() as any).updates).toHaveLength(1);
  });

  it("clears optional fields and edits the location the card shows", async () => {
    const lead = await makeLead({ companyLocation: undefined, contactLocation: "Cleburne, TX", companyWebsiteDomain: "old.example.test" });
    const response = await editContact(lead, { address: "Fort Worth, TX", website: "", phone: "", notes: "" });
    expect(response.status).toBe(200);
    const saved: any = await CrmLead.findById(lead._id).lean();
    expect(saved.contactLocation).toBe("Fort Worth, TX");
    expect(saved.companyLocation).toBeUndefined();
    expect(saved.website).toBeUndefined();
    expect(saved.companyWebsiteDomain).toBeUndefined();
    expect(saved.phoneRaw).toBeUndefined();
    expect(saved.notes).toBeUndefined();
  });

  it("rejects agents the lead is not assigned to without changing it", async () => {
    const lead = await makeLead();
    const response = await editContact(lead, { clientName: "Someone else" }, other);
    expect(response.status).toBe(403);
    expect((await CrmLead.findById(lead._id).lean() as any).clientName).toBe("Rick's Wrecker Service");
  });

  it.each([
    [{}, "Provide at least one contact field to edit"],
    [{ clientName: "  " }, "Contact name is required"],
    [{ email: "not-an-email" }, "Enter a valid email address"],
    [{ phone: "12" }, "Enter a valid phone number"],
    [{ notes: 42 }, "Notes must be text"],
    [{ companyName: "x".repeat(501) }, "Company is too long"],
  ])("rejects invalid input %j", async (body, message) => {
    const lead = await makeLead();
    const response = await editContact(lead, body);
    expect(response.status).toBe(400);
    expect(response.body.message).toBe(message);
    expect((await CrmLead.findById(lead._id).lean() as any).updates).toHaveLength(1);
  });
});
