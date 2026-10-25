import express from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Only transport authentication is replaced. The real database-backed review
// flag, production controllers, routers and owner middleware run unchanged.
vi.mock("../src/middleware/auth.middleware.js", () => ({
  protect: async (req: any, res: any, next: any) => {
    const { default: Users } = await import("../src/models/user.model.js");
    req.user = await Users.findById(req.headers["x-fixture-user"]);
    if (!req.user) return res.sendStatus(401);
    req.userId = String(req.user._id);
    next();
  },
}));
vi.mock("../src/service/previewReminderService.js", async (original) => ({
  ...await original<any>(), sendPreviewReminder: vi.fn(),
}));
vi.mock("../src/utils/sendVerificationEmail.js", async (original) => ({
  ...await original<any>(), sendTransactionalEmail: vi.fn(),
}));

let mongo: MongoMemoryServer;
let app: express.Express;
let User: any;
let Asset: any;
let Estate: any;
let Pdf: any;
let Listing: any;
let rawApiKey: string;
let reviewer: any;
let customer: any;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  User = (await import("../src/models/user.model.js")).default;
  Asset = (await import("../src/models/asset.model.js")).default;
  Estate = (await import("../src/models/realEstate.model.js")).default;
  Pdf = (await import("../src/models/pdfReport.model.js")).default;
  Listing = (await import("../src/models/lotListing.model.js")).default;
  app = express();
  app.use(express.json());
  app.use("/reports", (await import("../src/routes/pdfReport.routes.js")).default);
  app.use("/asset", (await import("../src/routes/asset.routes.js")).default);
  app.use("/estate", (await import("../src/routes/realEstate.routes.js")).default);
  app.use("/gallery", (await import("../src/routes/gallery.routes.js")).default);
  app.use("/auctioneer", (await import("../src/routes/auctioneer2.routes.js")).default);
  app.use("/auction-management", (await import("../src/routes/auctionManagement.routes.js")).default);
  app.use("/v1", (await import("../src/routes/publicApi.routes.js")).default);
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  vi.clearAllMocks();
  reviewer = await User.create({ username: "Review", email: "review@example.test", password: "hashed-test-only", isVerified: true, isReviewAccount: true });
  customer = await User.create({ username: "Customer", email: "customer@example.test", password: "hashed-test-only", isVerified: true });
  const { createApiKey } = await import("../src/service/apiKeyService.js");
  ({ rawKey: rawApiKey } = await createApiKey({ name: "Isolated partner test", createdBy: String(customer._id) }));
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

async function asset(owner: any, extra: Record<string, unknown> = {}) {
  return Asset.create({ user: owner._id, grouping_mode: "single_lot", imageUrls: ["https://assetinsight.test/original.jpg"], lots: [], status: "approved", contract_no: "Review fixture", ...extra });
}
async function pdf(owner: any, parent: any) {
  return Pdf.create({ user: owner._id, report: parent._id, filename: "fixture.pdf", address: "Fixture", fairMarketValue: "1", reportType: "Asset", reportModel: "AssetReport", fileType: "pdf", approvalStatus: "approved" });
}
function get(path: string, owner = reviewer) { return request(app).get(path).set("X-Fixture-User", String(owner._id)); }

describe("isolated reviewer production boundaries", () => {
  it("separates legacy report and Asset/RealEstate galleries without hiding ordinary customer reports", async () => {
    const own = await asset(reviewer);
    const real = await asset(customer);
    await pdf(reviewer, own); await pdf(customer, real);
    await Estate.collection.insertMany([
      { _id: new mongoose.Types.ObjectId(), user: reviewer._id, status: "approved", imageUrls: [], property_details: { address: "Review" } },
      { _id: new mongoose.Types.ObjectId(), user: customer._id, status: "approved", imageUrls: [], property_details: { address: "Private customer" } },
    ]);
    expect((await get("/reports")).body).toHaveLength(1);
    expect((await get("/asset/all-approved")).body.reports.map((x: any) => x._id)).toEqual([String(own._id)]);
    expect((await get("/estate/all-approved")).body.reports.map((x: any) => x.address)).toEqual(["Review"]);
    expect((await get("/asset/all-approved", customer)).body.reports.map((x: any) => x._id)).toEqual([String(real._id)]);
    expect((await get("/estate/all-approved", customer)).body.reports.map((x: any) => x.address)).toEqual(["Private customer"]);
    expect((await get("/reports", customer)).body).toHaveLength(1);
  });

  it("keeps review reports out of every partner detail/list/photo endpoint, even after account deletion", async () => {
    const lot = { lot_id: "lot-1", lot_number: "1", title: "Fixture only", image_urls: [], image_indexes: [] };
    const own = await asset(reviewer, { lots: [lot], imageUrls: [] });
    const real = await asset(customer, { lots: [lot], imageUrls: [] });
    const ownListing = await Listing.create({ user: reviewer._id, contract_no: "DEMO", sales_date: new Date(), location: "Demo", grouping_mode: "single_lot", status: "approved", lots: [lot], imageUrls: [] });
    const realListing = await Listing.create({ user: customer._id, contract_no: "REAL", sales_date: new Date(), location: "Real", grouping_mode: "single_lot", status: "approved", lots: [lot], imageUrls: [] });
    const partnerGet = (path: string) => request(app).get(`/v1${path}`).set("X-API-Key", rawApiKey);
    for (const [prefix, ownId, realId] of [["assets", own._id, real._id], ["lot-listings", ownListing._id, realListing._id]]) {
      const list = await partnerGet(`/${prefix}`);
      expect(list.status).toBe(200);
      expect(list.body.pagination.total).toBe(1);
      expect(list.body.data.map((row: any) => row._id)).toEqual([String(realId)]);
      for (const suffix of ["", "/images", "/lots", "/lots/lot-1", "/lots/lot-1/images"]) {
        const response = await partnerGet(`/${prefix}/${ownId}${suffix}`);
        expect(response.status).toBe(404);
      }
      expect((await partnerGet(`/${prefix}/${realId}`)).status).toBe(200);
    }
    const lots = await partnerGet("/lots");
    expect(lots.status).toBe(200);
    expect(lots.body.pagination.total).toBe(2);
    expect(JSON.stringify(lots.body)).not.toContain(String(own._id));
    expect(JSON.stringify(lots.body)).not.toContain(String(ownListing._id));
    const { default: Audit } = await import("../src/models/securityAuditEvent.model.js");
    const intent = await Audit.create({ action: "review_account_setup_requested", actorType: "admin", targetUser: reviewer._id });
    const { default: Boundary } = await import("../src/models/reviewAccountBoundary.model.js");
    await Boundary.create({ _id: reviewer._id, enrollmentAudit: intent._id });
    const { cascadeDeleteSecurityRecords } = await import("../src/service/deviceAccessService.js");
    await cascadeDeleteSecurityRecords(String(reviewer._id));
    await User.deleteOne({ _id: reviewer._id });
    expect(await Audit.exists({ _id: intent._id })).toBeNull();
    expect(await Boundary.exists({ _id: reviewer._id })).not.toBeNull();
    expect((await partnerGet(`/assets/${own._id}`)).status).toBe(404);
    expect((await partnerGet(`/lot-listings/${ownListing._id}`)).status).toBe(404);
    expect((await get("/asset/all-approved", customer)).body.reports.map((x: any) => x._id)).toEqual([String(real._id)]);
  });

  it("blocks foreign deletion and image changes before touching originals", async () => {
    const real = await asset(customer);
    const file = await pdf(customer, real);
    for (const id of [real._id, file._id]) {
      expect((await request(app).delete(`/reports/${id}`).set("X-Fixture-User", String(reviewer._id))).status).toBe(404);
    }
    const replaced = await request(app).post("/gallery/update-image").set("X-Fixture-User", String(reviewer._id))
      .send({ reportId: real._id, reportType: "asset", oldUrl: "https://assetinsight.test/original.jpg", newUrl: "https://assetinsight.test/changed.jpg" });
    expect(replaced.status).toBe(404);
    expect(await Pdf.countDocuments()).toBe(1);
    expect((await Asset.findById(real._id)).imageUrls).toEqual(["https://assetinsight.test/original.jpg"]);
  });

  it("allows the reviewer to manage their own report image", async () => {
    const own = await asset(reviewer);
    const result = await request(app).post("/gallery/update-image").set("X-Fixture-User", String(reviewer._id))
      .send({ reportId: own._id, reportType: "asset", oldUrl: "https://assetinsight.test/original.jpg", newUrl: "https://assetinsight.test/changed.jpg" });
    expect(result.status).toBe(200);
    expect((await Asset.findById(own._id)).imageUrls).toEqual(["https://assetinsight.test/changed.jpg"]);
  });

  it("does not expose incorrectly assigned customer approval/release work or allow decisions", async () => {
    const real = await asset(customer, { status: "pending_approval", approval_assigned_to: reviewer._id });
    const own = await asset(reviewer, { status: "pending_approval", approval_assigned_to: reviewer._id });
    const approvals = await get("/reports/assigned-approvals");
    expect(approvals.status).toBe(200);
    expect(JSON.stringify(approvals.body)).toContain(String(own._id));
    expect(JSON.stringify(approvals.body)).not.toContain(String(real._id));
    for (const suffix of ["preview", "asset-preview"]) expect((await get(`/reports/assigned-approvals/${real._id}/${suffix}`)).status).toBe(404);
    for (const suffix of ["approve", "reject", "resubmit", "preview/resubmit"]) {
      expect((await request(app).post(`/reports/assigned-approvals/${real._id}/${suffix}`).set("X-Fixture-User", String(reviewer._id)).send({})).status).toBe(404);
    }
    await Asset.updateMany({}, { $set: { status: "approved", release_status: "pending_release", release_assigned_to: reviewer._id } });
    const releases = await get("/reports/assigned-releases");
    expect(releases.status).toBe(200);
    expect(JSON.stringify(releases.body)).toContain(String(own._id));
    expect(JSON.stringify(releases.body)).not.toContain(String(real._id));
    expect((await request(app).post(`/reports/assigned-releases/${real._id}/release`).set("X-Fixture-User", String(reviewer._id))).status).toBe(404);
    expect((await Asset.findById(real._id)).release_status).toBe("pending_release");
  });

  it("returns empty live auction feeds and refuses all partner writes without provider access", async () => {
    // No provider configuration is required: the review fence precedes it.
    for (const path of ["/auctioneer/incoming", "/auctioneer/deliveries", "/auction-management/tasks"]) {
      const result = await get(path); expect(result.status).toBe(200); expect(result.body.data).toEqual([]);
    }
    expect((await get("/auctioneer/incoming/summary")).body).toEqual({ availableCount: 0 });
    expect((await get("/auctioneer/status")).body.data.reviewAccount).toBe(true);
    expect((await get("/auction-management/status")).body.reviewAccount).toBe(true);
    for (const path of ["/auctioneer/incoming/cycle/claim", "/auctioneer/deliveries/foreign/send", "/auctioneer/contracts/foreign/close-my-part", "/auction-management/tasks/foreign/opened"]) {
      const result = await request(app).post(path).set("X-Fixture-User", String(reviewer._id)).send({});
      expect(result.status).toBe(403); expect(result.body.code).toBe("REVIEW_ACCOUNT_ISOLATED");
    }
  });

  it("excludes reviewer supervisors and keeps reviewer reminders off the real supervisor inbox", async () => {
    const service = await import("../src/service/previewSupervisorService.js");
    const { runPreviewReviewReminderSweep } = await import("../src/jobs/previewReviewReminderJob.js");
    const { sendPreviewReminder } = await import("../src/service/previewReminderService.js");
    await expect(service.setGlobalPreviewSupervisorSetting(reviewer._id)).rejects.toThrow("active user");
    expect((await service.getPreviewSupervisorOptions()).some((u: any) => String(u._id) === String(reviewer._id))).toBe(false);
    await service.setGlobalPreviewSupervisorSetting(customer._id);
    const own = await asset(reviewer, { status: "preview" });
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await Asset.collection.updateOne({ _id: own._id }, { $set: { updatedAt: old, processing_completed_at: old } });
    await runPreviewReviewReminderSweep();
    expect(sendPreviewReminder).toHaveBeenCalledOnce();
    expect(String(vi.mocked(sendPreviewReminder).mock.calls[0][0].owner._id)).toBe(String(reviewer._id));
  });

  it.each([false, true])("excludes reviewer operational announcements, including queued work after account deletion=%s", async (deleted) => {
    const service = await import("../src/service/announcementService.js");
    const { default: Announcement } = await import("../src/models/announcement.model.js");
    const { default: Delivery } = await import("../src/models/announcementDelivery.model.js");
    const { sendTransactionalEmail } = await import("../src/utils/sendVerificationEmail.js");
    expect((await service.listAnnouncementRecipients({})).users.map((row: any) => row.id)).toEqual([String(customer._id)]);
    const announcement = await Announcement.create({ subject: "Private operational notice", heading: "Internal", message: "Customer operational details", audience: "all", requestId: "fixture", createdBy: customer._id });
    const delivery = await Delivery.create({ announcement: announcement._id, user: reviewer._id, email: reviewer.email, recipientName: "Review" });
    if (deleted) {
      const { default: Boundary } = await import("../src/models/reviewAccountBoundary.model.js");
      await Boundary.create({ _id: reviewer._id, enrollmentAudit: new mongoose.Types.ObjectId() });
      await User.deleteOne({ _id: reviewer._id });
    }
    // A failed delivery is not worker completion: another claim and announcement
    // aggregation still run. Hold that final aggregation in the first case to
    // prove the fixture must wait for the whole announcement before dropping DB.
    let finishAggregation = () => {};
    const aggregationGate = new Promise<void>((resolve) => { finishAggregation = resolve; });
    const aggregate = Delivery.aggregate.bind(Delivery);
    const aggregationSpy = deleted ? null : vi.spyOn(Delivery, "aggregate").mockImplementationOnce(async (pipeline: any) => {
      await aggregationGate;
      return aggregate(pipeline);
    });
    try {
      service.kickAnnouncementDeliveryWorker();
      await vi.waitFor(async () => expect((await Delivery.findById(delivery._id))?.status).toBe("failed"));
      if (!deleted) {
        await vi.waitFor(() => expect(aggregationSpy).toHaveBeenCalledOnce());
        expect((await Announcement.findById(announcement._id))?.status).toBe("sending");
      }
    } finally {
      finishAggregation();
      aggregationSpy?.mockRestore();
    }
    await vi.waitFor(async () => {
      const completed = await Announcement.findById(announcement._id);
      expect(completed?.status).toBe("failed");
      expect(completed?.failedCount).toBe(1);
      expect(completed?.completedAt).toBeInstanceOf(Date);
    });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });
});
