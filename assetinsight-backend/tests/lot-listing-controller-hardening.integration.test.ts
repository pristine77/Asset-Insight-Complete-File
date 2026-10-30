import jwt from "jsonwebtoken";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LotListing from "../src/models/lotListing.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import User from "../src/models/user.model.js";
import { buildAuctioneerSpecRows } from "../src/utils/auctioneerSpecRows.js";

const jobMocks = vi.hoisted(() => ({
  queueLotListingJob: vi.fn(),
  regenerateLotListingFiles: vi.fn(),
}));
const currencyProvider = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { responses: { create: currencyProvider.create } } }));

vi.mock("../src/jobs/lotListingJob.js", () => ({
  queueLotListingJob: jobMocks.queueLotListingJob,
  regenerateLotListingFiles: jobMocks.regenerateLotListingFiles,
}));

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
const originalDeviceApproval = process.env.DEVICE_APPROVAL_ENFORCEMENT;

function authHeader(userId: string) {
  return {
    Authorization: `Bearer ${jwt.sign(
      { id: userId, role: "admin" },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    )}`,
  };
}

async function createUser(role: "user" | "admin") {
  return User.create({
    email: `lot-hardening-${new mongoose.Types.ObjectId()}@example.test`,
    username: `lot-hardening-${new mongoose.Types.ObjectId()}`,
    password: "Password123!",
    authProvider: "email",
    isVerified: true,
    role,
  });
}

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  process.env.JWT_SECRET ||= "lot-listing-hardening-test-secret";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await LotListing.syncIndexes();
  jobMocks.queueLotListingJob.mockReset();
  jobMocks.regenerateLotListingFiles.mockReset();
  jobMocks.queueLotListingJob.mockResolvedValue(undefined);
  jobMocks.regenerateLotListingFiles.mockResolvedValue(undefined);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  if (originalDeviceApproval === undefined) {
    delete process.env.DEVICE_APPROVAL_ENFORCEMENT;
  } else {
    process.env.DEVICE_APPROVAL_ENFORCEMENT = originalDeviceApproval;
  }
});

function assignedPreviewData() {
  return {
    contract_no: "ASSIGNED-LOT-HARDENING",
    sales_date: "2026-09-01T00:00:00.000Z",
    location: "Regina, SK",
    currency: "CAD",
    valuation_methods: ["FML", "OLV"],
    lots: [
      {
        lot_id: "assigned-lot-1",
        lot_number: "1",
        title: "Assigned review lot",
        description: "Reviewed by the assigned approver",
        estimated_value: "CAD 1,000",
        condition_report_selections: {
          condition: "N/A",
          completeness: "N/A",
          legal: "N/A",
        },
      },
    ],
  };
}

async function createAssignedListing(ownerId: unknown, approverId: unknown) {
  const previewData = assignedPreviewData();
  return LotListing.create({
    user: ownerId,
    approval_assigned_to: approverId,
    contract_no: previewData.contract_no,
    sales_date: new Date(previewData.sales_date),
    location: previewData.location,
    imageUrls: [],
    videoUrls: [],
    lots: previewData.lots,
    status: "pending_approval",
    job_status: "done",
    valuation_methods: previewData.valuation_methods,
    preview_data: previewData,
  });
}

describe("Lot Listing controller hardening", () => {
  it.each(["owner-submit", "owner-resubmit", "assigned-approver"] as const)(
    "%s freezes reviewed spec deletion and edit in the exact generation snapshot", async (workflow) => {
      const owner = await createUser("admin");
      const approver = await createUser("admin");
      const listing = await createAssignedListing(owner._id, approver._id);
      if (workflow !== "assigned-approver") {
        listing.status = workflow === "owner-submit" ? "preview" : "error";
        listing.job_status = workflow === "owner-submit" ? "done" : "error";
        await listing.save();
      }
      const preview: any = assignedPreviewData();
      preview.lots[0] = { ...preview.lots[0], categories: "Portable Structures",
        description: "Width: 20 ft; Manufacturer: stale source", condition_report_specs: {},
        specifications: { Width: "20 ft" }, condition_report_specs_manual_overrides: {} };
      preview.lots.push({ ...preview.lots[0], lot_id: "second-independent", lot_number: "2",
        condition_report_specs: { "Overall Width": "18 ft" },
        condition_report_specs_manual_overrides: { "Overall Width": "18 ft" } });
      const path = workflow === "assigned-approver" ? `/api/reports/assigned-approvals/${listing._id}/preview/resubmit`
        : `/api/lot-listing/${listing._id}/${workflow === "owner-submit" ? "submit-approval" : "resubmit"}`;
      const actor = workflow === "assigned-approver" ? approver : owner;
      const response = await request(app).post(path).set(authHeader(String(actor._id))).send({ preview_data: preview });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      const persisted: any = await LotListing.findById(listing._id).lean();
      const snapshot = jobMocks.regenerateLotListingFiles.mock.calls[0][0].previewDataSnapshot;
      for (const current of [snapshot, persisted.preview_data, persisted]) {
        expect(current.lots[0].condition_report_specs || {}).toEqual({});
        expect(current.lots[0].condition_report_specs_reviewed).toBe(true);
        expect(buildAuctioneerSpecRows(current.lots[0]).filter((row) => row.checked || row.value)).toEqual([]);
        expect(current.lots[1].condition_report_specs).toEqual({ "Overall Width": "18 ft" });
        expect(current.lots[1].condition_report_specs_reviewed).toBe(true);
      }
      const retry = await request(app).post(path).set(authHeader(String(actor._id))).send({ preview_data: preview });
      expect(retry.status, JSON.stringify(retry.body)).toBe(202);
      expect((await LotListing.findById(listing._id).lean())?.job_id).toBe(persisted.job_id);
      expect(jobMocks.queueLotListingJob).not.toHaveBeenCalled();
    }
  );

  it("recreates a missing durable preview job on an exact multipart retry", async () => {
    const user = await createUser("admin");
    const clientSubmissionId = "orphaned-lot-create-retry";
    const generationToken = "orphaned-lot-preview-job";
    const listing = await LotListing.create({
      user: user._id,
      client_submission_id: clientSubmissionId,
      contract_no: "ORPHANED-LOT-CREATE",
      sales_date: new Date("2026-09-01T00:00:00.000Z"),
      location: "Regina, SK",
      imageUrls: [],
      videoUrls: [],
      lots: [],
      mixed_lots: [],
      status: "processing",
      job_id: generationToken,
      job_status: "queued",
      files_generating: true,
      valuation_methods: ["FML"],
    });

    const response = await request(app)
      .post("/api/lot-listing")
      .set(authHeader(String(user._id)))
      .field(
        "details",
        JSON.stringify({
          client_submission_id: clientSubmissionId,
          progress_id: generationToken,
          contract_no: listing.contract_no,
          sales_date: "2026-09-01T00:00:00.000Z",
          location: listing.location,
          valuation_methods: ["FML"],
        })
      )
      .attach("images", Buffer.from("retry-image"), {
        filename: "retry.jpg",
        contentType: "image/jpeg",
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      reportId: String(listing._id),
      jobId: generationToken,
      resumed: true,
      recovered: true,
    });
    expect(jobMocks.queueLotListingJob).toHaveBeenCalledTimes(1);
    expect(jobMocks.queueLotListingJob).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: String(listing._id),
        progressId: generationToken,
        images: [expect.objectContaining({ originalname: "retry.jpg" })],
      })
    );
  });

  it("retains request sources when a queue failure cannot be reconciled", async () => {
    const user = await createUser("admin");
    jobMocks.queueLotListingJob.mockRejectedValueOnce(
      new Error("ambiguous queue write")
    );
    const findJobSpy = vi.spyOn(ReportJob, "findOne").mockReturnValue({
      lean: () => Promise.reject(new Error("Mongo read unavailable")),
    } as any);
    let retainedPath = "";

    try {
      const response = await request(app)
        .post("/api/lot-listing")
        .set(authHeader(String(user._id)))
        .field(
          "details",
          JSON.stringify({
            client_submission_id: "ambiguous-lot-queue",
            progress_id: "ambiguous-lot-queue",
            contract_no: "AMBIGUOUS-LOT-QUEUE",
            sales_date: "2026-09-01T00:00:00.000Z",
            location: "Regina, SK",
            valuation_methods: ["FML"],
          })
        )
        .attach("images", Buffer.from("possibly-owned-image"), {
          filename: "possibly-owned.jpg",
          contentType: "image/jpeg",
        });

      retainedPath = String(
        jobMocks.queueLotListingJob.mock.calls[0]?.[0]?.images?.[0]?.path || ""
      );
      expect(response.status).toBe(503);
      expect(response.body.message).toContain("could not be confirmed");
      expect(retainedPath).not.toBe("");
      expect(existsSync(retainedPath)).toBe(true);
    } finally {
      findJobSpy.mockRestore();
      if (retainedPath) await unlink(retainedPath).catch(() => undefined);
    }
  });

  it("coalesces a simultaneous multipart create after the unique idempotency key wins", async () => {
    const user = await createUser("admin");
    const details = {
      client_submission_id: "simultaneous-lot-create",
      progress_id: "simultaneous-lot-create",
      contract_no: "SIMULTANEOUS-LOT-CREATE",
      sales_date: "2026-09-01T00:00:00.000Z",
      location: "Regina, SK",
      valuation_methods: ["FML"],
    };

    const originalSave = LotListing.prototype.save;
    let releaseSaves!: () => void;
    let bothSavesReached!: () => void;
    let saveCount = 0;
    const saveGate = new Promise<void>((resolve) => {
      releaseSaves = resolve;
    });
    const bothSaves = new Promise<void>((resolve) => {
      bothSavesReached = resolve;
    });
    const saveSpy = vi
      .spyOn(LotListing.prototype, "save")
      .mockImplementation(async function (...args: any[]) {
        if ((this as any).client_submission_id === details.client_submission_id) {
          saveCount += 1;
          if (saveCount === 2) {
            bothSavesReached();
            releaseSaves();
          }
          await saveGate;
        }
        return originalSave.apply(this, args as any);
      } as any);

    try {
      const first = request(app)
        .post("/api/lot-listing")
        .set(authHeader(String(user._id)))
        .field("details", JSON.stringify(details))
        .then((response) => response);
      const second = request(app)
        .post("/api/lot-listing")
        .set(authHeader(String(user._id)))
        .field("details", JSON.stringify(details))
        .then((response) => response);

      await bothSaves;
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([202, 202]);
      expect(await LotListing.countDocuments({
        user: user._id,
        client_submission_id: details.client_submission_id,
      })).toBe(1);
      expect(jobMocks.queueLotListingJob).toHaveBeenCalledTimes(1);
      expect(String(responses[0].body.reportId)).toBe(
        String(responses[1].body.reportId)
      );
      expect(responses[0].body.jobId).toBe(responses[1].body.jobId);
    } finally {
      releaseSaves();
      saveSpy.mockRestore();
    }
  });

  it("queues assigned-review files without FMV or appraisal selections", async () => {
    const owner = await createUser("user");
    const approver = await createUser("admin");
    const listing = await createAssignedListing(owner._id, approver._id);
    const previewData = assignedPreviewData();
    previewData.lots[0].estimated_value = "";
    previewData.lots[0].lot_number = "750";
    previewData.lots[0].condition_report_selections = { condition: "", completeness: "", legal: "" };

    const response = await request(app)
      .post(`/api/reports/assigned-approvals/${listing._id}/preview/resubmit`)
      .set(authHeader(String(approver._id)))
      .send({ preview_data: previewData });

    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(jobMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);
    const saved = await LotListing.findById(listing._id).lean();
    expect((saved?.preview_data as any).lots[0]).toMatchObject({
      lot_number: "750", estimated_value: "", image_urls: [],
    });
  });

  it("coalesces an assigned-approver double resubmit onto one generation token", async () => {
    const owner = await createUser("user");
    const approver = await createUser("admin");
    const listing = await createAssignedListing(owner._id, approver._id);
    const previewData = assignedPreviewData();
    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    jobMocks.regenerateLotListingFiles.mockImplementationOnce(() => queueGate);

    const first = request(app)
      .post(`/api/reports/assigned-approvals/${listing._id}/preview/resubmit`)
      .set(authHeader(String(approver._id)))
      .send({ preview_data: previewData })
      .then((response) => response);
    await vi.waitFor(() => {
      expect(jobMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);
    });

    const second = await request(app)
      .post(`/api/reports/assigned-approvals/${listing._id}/preview/resubmit`)
      .set(authHeader(String(approver._id)))
      .send({ preview_data: previewData });
    expect(second.status).toBe(202);
    expect(jobMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);
    const liveToken = (await LotListing.findById(listing._id).lean())?.job_id;
    expect(second.body.data.job_id).toBe(liveToken);

    releaseQueue();
    expect((await first).status).toBe(202);
  });

  it("keeps assigned preview root identity and coordinate clearing in sync", async () => {
    const owner = await createUser("user");
    const approver = await createUser("admin");
    const listing = await createAssignedListing(owner._id, approver._id);
    listing.latitude = 50.4452;
    listing.longitude = -104.6189;
    await listing.save();
    const previewData = {
      ...assignedPreviewData(),
      contract_no: "  Assigned   Lot  Updated  ",
      sales_date: "2026-10-15T00:00:00.000Z",
      location: "Saskatoon, SK",
      currency: "usd",
      valuation_methods: ["olv", "FML", "olv"],
      total_value: 1_250,
    };
    const description = "Websites for reference: https://www.freightfarms.com/\n\nFull greenhouse inspection details, growing racks and accessories.\nAdditional appraiser notes must remain here after saving.";
    previewData.lots[0].description = description;

    // Currency changes now require an attributable conversion rather than a
    // prefix-only relabel. Preserve this test's existing root/coordinate checks.
    const opened = await request(app).get(`/api/reports/assigned-approvals/${listing._id}/preview`).set(authHeader(String(approver._id)));
    expect(opened.status).toBe(200);
    const sourceUrl = "https://www.bankofcanada.ca/rates/exchange/daily-exchange-rates/";
    currencyProvider.create.mockResolvedValueOnce({ status: "completed", output_text: JSON.stringify({ fromCurrency: "CAD", toCurrency: "USD", rate: .5, asOf: new Date().toISOString().slice(0, 10), sourceUrl, sourceTitle: "Bank of Canada rates" }), output: [{ type: "web_search_call", action: { sources: [{ url: sourceUrl }] } }] });
    const converted = await request(app).post(`/api/reports/assigned-approvals/${listing._id}/preview/currency-conversion`).set(authHeader(String(approver._id))).send({ targetCurrency: "USD", preview_data: { ...previewData, currency: "CAD", _currency_base_revision: opened.body.data.preview_data._currency_base_revision } });
    expect(converted.status).toBe(200);

    const response = await request(app)
      .put(`/api/reports/assigned-approvals/${listing._id}/preview`)
      .set(authHeader(String(approver._id)))
      .send({ preview_data: { ...converted.body.data.preview_data, total_value: 1250 } });

    expect(response.status).toBe(200);
    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted).toMatchObject({
      contract_no: "  Assigned   Lot  Updated  ",
      contract_key: "assigned lot updated",
      location: "Saskatoon, SK",
      currency: "USD",
      total_value: 1_250,
      valuation_methods: ["OLV", "FML"],
    });
    expect(new Date(persisted.sales_date).toISOString()).toBe(
      "2026-10-15T00:00:00.000Z"
    );
    expect(persisted.latitude).toBeUndefined();
    expect(persisted.longitude).toBeUndefined();
    expect(persisted.preview_data.valuation_methods).toEqual(["OLV", "FML"]);
    expect(persisted.preview_data.lots[0].description).toBe(description);
    expect(persisted.lots[0].description).toBe(description);
  });

  it("queues legacy assigned Lot Listings for automatic approval and release", async () => {
    const owner = await createUser("user");
    const approver = await createUser("admin");
    const listing = await createAssignedListing(owner._id, approver._id);
    const response = await request(app)
      .post(`/api/reports/assigned-approvals/${listing._id}/preview/resubmit`)
      .set(authHeader(String(approver._id)))
      .send({ preview_data: assignedPreviewData() });
    expect(response.status).toBe(202);
    expect(response.body.message).toContain("approved and released automatically");
    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted).toMatchObject({ status: "processing", job_status: "queued", generation_target_status: "approved" });
    expect(persisted.released_at).toBeFalsy();
    expect(jobMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);
  });

  it("restores assigned edit access without releasing files when the Lot Listing queue call fails", async () => {
    const owner = await createUser("user");
    const approver = await createUser("admin");
    const listing = await createAssignedListing(owner._id, approver._id);
    jobMocks.regenerateLotListingFiles.mockRejectedValueOnce(
      new Error("assigned Lot queue unavailable")
    );

    const response = await request(app)
      .post(`/api/reports/assigned-approvals/${listing._id}/preview/resubmit`)
      .set(authHeader(String(approver._id)))
      .send({ preview_data: assignedPreviewData() });

    expect(response.status).toBe(500);
    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted).toMatchObject({
      status: "pending_approval",
      job_status: "error",
      files_generating: false,
      files_regenerating: false,
      generation_target_status: "approved",
    });
    expect(persisted.job_error).toContain("assigned Lot queue unavailable");
  });
});
