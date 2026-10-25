import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let CrmAutoFindLead: typeof import("../src/models/crmAutoFindLead.model.js")["default"];
let seedSuperAdmin: typeof import("../src/service/adminService.js")["seedSuperAdmin"];

function authHeaders(id: string, role: "admin" | "superadmin") {
  return {
    Authorization: `Bearer ${jwt.sign(
      { id, role },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    )}`,
  };
}

async function createAdmin(role: "admin" | "superadmin") {
  return User.create({
    email: `${role}@example.test`,
    username: role,
    companyName: "Asset Insight",
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
    role,
  });
}

async function createUser(email: string) {
  return User.create({
    email,
    username: email.split("@")[0],
    companyName: "Asset Insight",
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
    role: "user",
  });
}

async function createAssetReport(
  userId: mongoose.Types.ObjectId,
  status: "preview" | "pending_approval" | "approved",
  contractNo: string,
  approvalAssignedTo?: mongoose.Types.ObjectId
) {
  return AssetReport.create({
    user: userId,
    grouping_mode: "single_lot",
    imageUrls: [],
    lots: [],
    status,
    contract_no: contractNo,
    preview_data: { client_name: contractNo, contract_no: contractNo },
    ...(approvalAssignedTo
      ? { approval_assigned_to: approvalAssignedTo }
      : {}),
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: CrmAutoFindLead } = await import(
    "../src/models/crmAutoFindLead.model.js"
  ));
  ({ seedSuperAdmin } = await import("../src/service/adminService.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("superadmin feature access", () => {
  it("rejects regular admins from every restricted feature API", async () => {
    const admin = await createAdmin("admin");
    const headers = authHeaders(String(admin._id), "admin");

    const responses = await Promise.all([
      request(app).get("/api/admin/stats/desktop-dashboard").set(headers),
      request(app).get("/api/admin/preview-reports").set(headers),
      request(app).get("/api/admin/admins").set(headers),
      request(app).get("/api/crm/admin/revenue-radar").set(headers),
      request(app).get("/api/admin/apk-releases").set(headers),
      request(app).get("/api/admin/report-jobs/stats").set(headers),
      request(app).get("/api/admin/spec-web-search").set(headers),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body.message).toBe("Superadmin privileges required");
    }
  });

  it("allows superadmins to load every restricted feature API", async () => {
    const superadmin = await createAdmin("superadmin");
    const headers = authHeaders(String(superadmin._id), "superadmin");

    const responses = await Promise.all([
      request(app).get("/api/admin/stats/desktop-dashboard").set(headers),
      request(app).get("/api/admin/preview-reports").set(headers),
      request(app).get("/api/admin/admins").set(headers),
      request(app).get("/api/crm/admin/revenue-radar").set(headers),
      request(app).get("/api/admin/apk-releases").set(headers),
      request(app).get("/api/admin/report-jobs/stats").set(headers),
      request(app).get("/api/admin/spec-web-search").set(headers),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
    }
  });

  it("requires a superadmin even when the APK direct-upload token belongs to an admin", async () => {
    const admin = await createAdmin("admin");
    const token = jwt.sign(
      { id: String(admin._id), purpose: "apk-release-upload" },
      process.env.JWT_SECRET!,
      { expiresIn: "10m" }
    );

    const response = await request(app)
      .post("/api/admin/apk-releases/direct")
      .set("x-apk-upload-token", token);

    expect(response.status).toBe(403);
    expect(response.body.message).toBe("Superadmin privileges required");
  });

  it("keeps regular admins on approved reports and blocks preview-state records", async () => {
    const [admin, otherAdmin, superadmin, creator] = await Promise.all([
      createAdmin("admin"),
      User.create({
        email: "other-admin@example.test",
        username: "other-admin",
        companyName: "Asset Insight",
        password: await bcrypt.hash("Password123!", 4),
        authProvider: "email",
        isVerified: true,
        role: "admin",
      }),
      createAdmin("superadmin"),
      createUser("creator@example.test"),
    ]);
    const [approved, preview, assignedPending] = await Promise.all([
      createAssetReport(creator._id, "approved", "APPROVED-001"),
      createAssetReport(creator._id, "preview", "PREVIEW-001"),
      createAssetReport(
        creator._id,
        "pending_approval",
        "PENDING-001",
        otherAdmin._id
      ),
    ]);
    const adminHeaders = authHeaders(String(admin._id), "admin");

    const defaultList = await request(app)
      .get("/api/admin/reports")
      .set(adminHeaders);
    expect(defaultList.status).toBe(200);
    expect(defaultList.body.items).toHaveLength(1);
    expect(defaultList.body.items[0]?.contract_no).toBe("APPROVED-001");

    const pendingList = await request(app)
      .get("/api/admin/reports")
      .query({ approvalStatus: "pending" })
      .set(adminHeaders);
    expect(pendingList.status).toBe(403);
    expect(pendingList.body.message).toBe(
      "Superadmin privileges required"
    );

    const approvedPreview = await request(app)
      .get(`/api/admin/reports/${approved._id}/preview`)
      .set(adminHeaders);
    expect(approvedPreview.status).toBe(200);

    for (const reportId of [preview._id, assignedPending._id]) {
      const response = await request(app)
        .get(`/api/admin/reports/${reportId}/preview`)
        .set(adminHeaders);
      expect(response.status).toBe(403);
      expect(response.body.message).toBe(
        "Superadmin privileges required"
      );
    }

    const superadminPendingList = await request(app)
      .get("/api/admin/reports")
      .query({ approvalStatus: "pending" })
      .set(authHeaders(String(superadmin._id), "superadmin"));
    expect(superadminPendingList.status).toBe(200);
    expect(superadminPendingList.body.items).toHaveLength(1);
    expect(superadminPendingList.body.items[0]?.contract_no).toBe(
      "PENDING-001"
    );
  });

  it("does not let an admin import another user's Revenue Radar results", async () => {
    const [admin, superadmin] = await Promise.all([
      createAdmin("admin"),
      createAdmin("superadmin"),
    ]);
    const radarResult = await CrmAutoFindLead.create({
      fingerprint: "radar-result-1",
      identityKey: "radar-result-1",
      status: "previewed",
      foundBy: superadmin._id,
      lead: {
        companyName: "Private Radar Lead",
        contactName: "Test Contact",
      },
    });

    const response = await request(app)
      .post("/api/crm/admin/leads/auto-find/import")
      .set(authHeaders(String(admin._id), "admin"))
      .send({ resultIds: [String(radarResult._id)] });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(
      "No selected auto-found leads are available to import"
    );
    expect(
      await CrmAutoFindLead.exists({
        _id: radarResult._id,
        status: "previewed",
      })
    ).toBeTruthy();
  });

  it("removes remote superadmin seeding while preserving the CLI service", async () => {
    const attackerEmail = "attacker-superadmin@example.test";
    const response = await request(app).post("/api/admin/seed").send({
      email: attackerEmail,
      password: "AttackerPassword123!",
    });

    expect(response.status).toBe(404);
    expect(await User.exists({ email: attackerEmail })).toBeNull();

    const result = await seedSuperAdmin({
      email: "cli-superadmin@example.test",
      password: "CliPassword123!",
      username: "cli-superadmin",
      companyName: "Asset Insight",
    });
    expect(result.created).toBe(true);
    expect(
      await User.exists({
        email: "cli-superadmin@example.test",
        role: "superadmin",
        isVerified: true,
      })
    ).toBeTruthy();
  });
});
