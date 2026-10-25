import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Dashboard reads need only the isolated database. Do not load local provider
// configuration while importing the application and its unrelated adapters.
vi.mock("dotenv", () => {
  const config = () => ({ parsed: {} });
  return { default: { config }, config };
});
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let RealEstateReport: typeof import("../src/models/realEstate.model.js")["default"];
let PdfReport: typeof import("../src/models/pdfReport.model.js")["default"];
let ownerId: mongoose.Types.ObjectId;
let authorization: string;

beforeAll(async () => {
  vi.stubEnv("RESEND_API_KEY", "re_dashboard_test_only");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
  ({ default: RealEstateReport } = await import("../src/models/realEstate.model.js"));
  ({ default: PdfReport } = await import("../src/models/pdfReport.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  const admin = await User.create({
    email: "dashboard-superadmin@example.test",
    username: "dashboard-superadmin",
    companyName: "Dashboard fixtures",
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
    role: "superadmin",
  });
  ownerId = admin._id;
  authorization = `Bearer ${jwt.sign(
    { id: String(admin._id), role: "superadmin" },
    process.env.JWT_SECRET!,
    { expiresIn: "30m" }
  )}`;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  vi.unstubAllEnvs();
});

// Raw historical fixtures preserve exact timestamps and exercise legacy records
// without replacing omitted fields with today's Mongoose defaults.
function reportRecord(createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    user: ownerId,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    status: "preview",
    lots: [],
    imageUrls: [],
    ...extra,
  };
}

function artifactRecord(
  reportType: "Asset" | "RealEstate" | "Salvage",
  report: mongoose.Types.ObjectId | null,
  createdAt: string
) {
  return reportRecord(createdAt, {
    reportType,
    reportModel: `${reportType}Report`,
    ...(report ? { report } : {}),
    filename: "dashboard-fixture.pdf",
    address: "Synthetic dashboard fixture",
    approvalStatus: "approved",
  });
}

async function dashboard(from = "2026-09-10", to = "2026-09-12") {
  const response = await request(app)
    .get("/api/admin/stats/desktop-dashboard")
    .set("Authorization", authorization)
    .query({ from, to });
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  return response.body;
}

function expectMatchingReportTotals(payload: any, total: number) {
  expect(payload.kpis.reports.value).toBe(total);
  expect(payload.byType.reduce((sum: number, row: any) => sum + row.value, 0)).toBe(total);
  expect(payload.activity.reduce((sum: number, row: any) => sum + row.value, 0)).toBe(total);
}

describe.sequential("desktop dashboard metric integrity", () => {
  it("counts parent reports once and only adds grouped Salvage artifacts to daily activity", async () => {
    const asset = reportRecord("2026-09-10T09:00:00.000Z", {
      preview_data: { lots: [{ title: "Asset one" }, { title: "Asset two" }] },
    });
    const realEstate = reportRecord("2026-09-11T09:00:00.000Z");
    const salvageId = new mongoose.Types.ObjectId();
    await AssetReport.collection.insertOne(asset);
    await LotListing.collection.insertOne(reportRecord("2026-09-10T10:00:00.000Z", {
      lots: [{ title: "Listing one" }, { title: "Listing two" }, { title: "Listing three" }],
    }));
    await RealEstateReport.collection.insertOne(realEstate);
    await PdfReport.collection.insertMany([
      artifactRecord("Asset", asset._id, "2026-09-10T12:00:00.000Z"),
      artifactRecord("Asset", asset._id, "2026-09-11T12:00:00.000Z"),
      artifactRecord("RealEstate", realEstate._id, "2026-09-11T13:00:00.000Z"),
      ...["10T15", "10T16", "11T15", "11T16"].map((dayHour) =>
        artifactRecord("Salvage", salvageId, `2026-09-${dayHour}:00:00.000Z`)
      ),
    ]);

    const payload = await dashboard();
    expectMatchingReportTotals(payload, 4);
    expect(payload.byType).toEqual([
      { type: "Asset", value: 1 },
      { type: "LotListing", value: 1 },
      { type: "RealEstate", value: 1 },
      { type: "Salvage", value: 1 },
    ]);
    expect(payload.activity).toEqual([
      { date: "2026-09-10", value: 3 },
      { date: "2026-09-11", value: 1 },
      { date: "2026-09-12", value: 0 },
    ]);
    expect(payload.kpis.lots.value).toBe(5);
    expect(payload.kpis.lotListings.value).toBe(1);
  });

  it("retains separate legacy Salvage artifacts when no parent reference is saved", async () => {
    await PdfReport.collection.insertMany([
      artifactRecord("Salvage", null, "2026-09-10T08:00:00.000Z"),
      artifactRecord("Salvage", null, "2026-09-10T09:00:00.000Z"),
    ]);
    const payload = await dashboard();
    expectMatchingReportTotals(payload, 2);
    expect(payload.byType.find((row: any) => row.type === "Salvage").value).toBe(2);
  });

  it("preserves Salvage grouping within each period instead of changing its historical date basis", async () => {
    const salvageId = new mongoose.Types.ObjectId();
    await PdfReport.collection.insertMany([
      artifactRecord("Salvage", salvageId, "2026-09-09T23:59:59.999Z"),
      artifactRecord("Salvage", salvageId, "2026-09-10T00:00:00.000Z"),
      artifactRecord("Salvage", salvageId, "2026-09-11T12:00:00.000Z"),
    ]);
    const payload = await dashboard();
    expectMatchingReportTotals(payload, 1);
    expect(payload.kpis.reports.percent).toBe(0);
    expect(payload.activity).toEqual([
      { date: "2026-09-10", value: 1 },
      { date: "2026-09-11", value: 0 },
      { date: "2026-09-12", value: 0 },
    ]);
  });

  it("uses inclusive UTC days and the immediately preceding equal-length period", async () => {
    await AssetReport.collection.insertMany([
      "2026-09-07T23:59:59.999Z",
      "2026-09-08T00:00:00.000Z",
      "2026-09-09T23:59:59.999Z",
      "2026-09-10T00:00:00.000Z",
      "2026-09-11T23:59:59.999Z",
      "2026-09-12T00:00:00.000Z",
    ].map((date) => reportRecord(date)));
    const payload = await dashboard("2026-09-10", "2026-09-11");
    expectMatchingReportTotals(payload, 2);
    expect(payload.range).toEqual({
      from: "2026-09-10T00:00:00.000Z",
      to: "2026-09-11T23:59:59.999Z",
    });
    expect(payload.kpis.reports.percent).toBe(0);
    expect(payload.activity).toEqual([
      { date: "2026-09-10", value: 1 },
      { date: "2026-09-11", value: 1 },
    ]);
  });

  it("excludes Asset and Lot Listing draft derivatives from counts, lots and activity", async () => {
    for (const model of [AssetReport, LotListing]) {
      await model.collection.insertMany([
        reportRecord("2026-09-10T08:00:00.000Z", { lots: [{ title: "Normal lot" }] }),
        reportRecord("2026-09-10T09:00:00.000Z", {
          is_draft_preview: true,
          status: "pending_approval",
          preview_data: { lots: [{ title: "Draft lot" }, { title: "Another draft lot" }] },
        }),
      ]);
    }
    const payload = await dashboard();
    expectMatchingReportTotals(payload, 2);
    expect(payload.kpis.lots.value).toBe(2);
    expect(payload.kpis.pending).toBe(0);
    expect(payload.recentReports).toHaveLength(2);
  });

  it("preserves all-time status and user totals independently of the selected date range", async () => {
    await User.create({
      email: "blocked-dashboard-user@example.test",
      username: "blocked-dashboard-user",
      password: await bcrypt.hash("Password123!", 4),
      role: "user",
      isBlocked: true,
      isVerified: false,
    });
    await AssetReport.collection.insertMany([
      reportRecord("2026-08-01T08:00:00.000Z", { status: "pending_approval" }),
      reportRecord("2026-08-01T09:00:00.000Z", {
        status: "approved",
        release_status: "pending_release",
        adminArchivedAt: new Date("2026-08-02T09:00:00.000Z"),
      }),
    ]);
    const payload = await dashboard();
    expectMatchingReportTotals(payload, 0);
    expect(payload.kpis).toMatchObject({ pending: 1, released: 1, users: { value: 1 } });
    expect(payload.recentReports).toHaveLength(1);
    expect(payload.queue.pendingReview).toBe(payload.queue.awaitingApproval);
    expect(payload.queue.inReview).toBe(payload.queue.preparingPreview + payload.queue.generatingFiles);
    expect(payload.queue.readyForRelease).toBe(payload.queue.awaitingRelease);
  });
});
