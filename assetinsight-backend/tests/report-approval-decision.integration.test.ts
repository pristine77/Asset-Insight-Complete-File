import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const sideEffects = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendReportApprovedEmail: vi.fn(),
  sendReportDeclinedEmail: vi.fn(),
  notifyUser: vi.fn(),
  assignReleaseManager: vi.fn(),
}));

vi.mock("../src/utils/sendVerificationEmail.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/utils/sendVerificationEmail.js")
  >()),
  sendEmail: sideEffects.sendEmail,
}));

vi.mock("../src/service/assetEmailService.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/service/assetEmailService.js")
  >()),
  sendReportApprovedEmail: sideEffects.sendReportApprovedEmail,
  sendReportDeclinedEmail: sideEffects.sendReportDeclinedEmail,
}));

vi.mock("../src/service/notificationService.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/service/notificationService.js")
  >()),
  notifyUser: sideEffects.notifyUser,
}));

vi.mock("../src/service/reportReleaseService.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/service/reportReleaseService.js")
  >();
  return {
    ...actual,
    assignReleaseManager: (...args: Parameters<typeof actual.assignReleaseManager>) =>
      sideEffects.assignReleaseManager(actual.assignReleaseManager, ...args),
  };
});

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let PdfReport: typeof import("../src/models/pdfReport.model.js")["default"];
let RealEstateReport: typeof import("../src/models/realEstate.model.js")["default"];

function adminHeaders(id: string) {
  return {
    Authorization: `Bearer ${jwt.sign(
      { id, role: "admin" },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    )}`,
  };
}

async function createAccount(role: "user" | "admin" | "superadmin" = "user") {
  const suffix = new mongoose.Types.ObjectId().toHexString();
  return User.create({
    email: `approval-decision-${suffix}@example.test`,
    username: `approval-decision-${suffix}`,
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
    role,
  });
}

async function createReadyAsset(ownerId: unknown, approverId: unknown) {
  return AssetReport.create({
    user: ownerId,
    approval_assigned_to: approverId,
    grouping_mode: "single_lot",
    imageUrls: [],
    lots: [],
    status: "pending_approval",
    job_status: "done",
    contract_no: "APPROVAL-CAS-001",
    preview_data: {
      contract_no: "APPROVAL-CAS-001",
      client_name: "Approval CAS",
      lots: [],
    },
    preview_files: {
      docx: "https://files.example/report.docx",
      excel: "https://files.example/report.xlsx",
      images: "https://files.example/images.zip",
    },
  });
}

async function createReadyRealEstate(ownerId: unknown, approverId: unknown) {
  return RealEstateReport.create({
    user: ownerId,
    approval_assigned_to: approverId,
    status: "pending_approval",
    job_status: "done",
    release_status: "pending_release",
    preview_files: {
      docx: "https://files.example/report.docx",
      excel: "https://files.example/report.xlsx",
      images: "https://files.example/photos.zip",
    },
  });
}

function pauseRealEstateDecision(status: "approved" | "declined") {
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => { arrived = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = RealEstateReport.findOneAndUpdate;
  const spy = vi.spyOn(RealEstateReport, "findOneAndUpdate").mockImplementation(
    ((...args: any[]) => {
      const query = (original as any).apply(RealEstateReport, args);
      if (args[1]?.$set?.status === status) {
        const execute = query.exec.bind(query);
        query.exec = async () => {
          arrived();
          await gate;
          return execute();
        };
      }
      return query;
    }) as typeof RealEstateReport.findOneAndUpdate
  );
  return { reached, release, restore: () => spy.mockRestore() };
}

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  process.env.JWT_SECRET ||= "approval-decision-test-secret";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
  ({ default: PdfReport } = await import("../src/models/pdfReport.model.js"));
  ({ default: RealEstateReport } = await import("../src/models/realEstate.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  for (const mock of Object.values(sideEffects)) mock.mockReset();
  sideEffects.sendEmail.mockResolvedValue(undefined);
  sideEffects.sendReportApprovedEmail.mockResolvedValue(undefined);
  sideEffects.sendReportDeclinedEmail.mockResolvedValue(undefined);
  sideEffects.notifyUser.mockResolvedValue(undefined);
  sideEffects.assignReleaseManager.mockImplementation(
    async (original: (...args: any[]) => Promise<any>, ...args: any[]) =>
      original(...args)
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("report approval decision ownership", () => {
  it.each(["admin", "superadmin"] as const)("%s approves and releases Real Estate despite a configured release manager", async (role) => {
    const manager = await createAccount();
    const owner = await createAccount();
    await User.updateOne({ _id: owner._id }, { $set: { releaseManager: manager._id } });
    const approver = await createAccount(role);
    const report = await RealEstateReport.create({
      user: owner._id, status: "pending_approval", job_status: "done",
      approval_assigned_to: role === "superadmin" ? manager._id : approver._id,
      property_details: { address: "123 Test Street" },
      preview_files: { docx: "https://files.example/report.docx", excel: "https://files.example/report.xlsx", images: "https://files.example/photos.zip" },
      release_status: "pending_release", release_assigned_to: manager._id,
      release_assigned_at: new Date(), release_assignment_email_sent_at: new Date(),
    });
    const responses = await Promise.all([
      request(app).patch(`/api/admin/reports/${report._id}/approve`).set(adminHeaders(String(approver._id))),
      request(app).post(`/api/real-estate/admin/${report._id}/approve`).set(adminHeaders(String(approver._id))),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const saved = await RealEstateReport.findById(report._id).lean();
    expect(saved).toMatchObject({ status: "approved", release_status: "released", release_assigned_source: "auto_released", release_assigned_to: null, release_assigned_at: null, release_assignment_email_sent_at: null });
    expect(String(saved?.released_by)).toBe(String(approver._id));
    expect(saved?.released_at).toBeInstanceOf(Date);
    expect(sideEffects.sendEmail).toHaveBeenCalledTimes(1);
    expect(sideEffects.notifyUser).toHaveBeenCalledTimes(1);
    expect(sideEffects.assignReleaseManager).not.toHaveBeenCalled();
    const retry = await request(app).patch(`/api/admin/reports/${report._id}/approve`).set(adminHeaders(String(approver._id)));
    expect(retry.status).toBe(200);
    expect(retry.body.already_processed).toBe(true);
    expect((await RealEstateReport.findById(report._id).lean())?.released_at).toEqual(saved?.released_at);
    expect(sideEffects.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("does not approve or release incomplete Real Estate files or admit an ordinary user", async () => {
    const owner = await createAccount();
    const approver = await createAccount("admin");
    const report = await RealEstateReport.create({ user: owner._id, status: "pending_approval", job_status: "done", release_status: "pending_release", preview_files: { docx: "https://files.example/only.docx" } });
    expect((await request(app).patch(`/api/admin/reports/${report._id}/approve`).set(adminHeaders(String(owner._id)))).status).toBe(403);
    expect((await request(app).post(`/api/real-estate/admin/${report._id}/approve`).set(adminHeaders(String(owner._id)))).status).toBe(403);
    for (const route of ["admin", "direct"]) {
      const response = route === "admin"
        ? await request(app).patch(`/api/admin/reports/${report._id}/approve`).set(adminHeaders(String(approver._id)))
        : await request(app).post(`/api/real-estate/admin/${report._id}/approve`).set(adminHeaders(String(approver._id)));
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("FILES_UNAVAILABLE");
    }
    expect(await RealEstateReport.findById(report._id).lean()).toMatchObject({ status: "pending_approval", release_status: "pending_release" });
    expect(sideEffects.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["admin", "approved"],
    ["direct", "approved"],
    ["admin", "declined"],
    ["direct", "declined"],
  ] as const)(
    "fences a stale %s-route %s decision against the opposing Real Estate decision",
    async (approvalRoute, staleStatus) => {
      const owner = await createAccount();
      const approver = await createAccount("admin");
      const report = await createReadyRealEstate(owner._id, approver._id);
      const headers = adminHeaders(String(approver._id));
      const approve = () => approvalRoute === "admin"
        ? request(app).patch(`/api/admin/reports/${report._id}/approve`).set(headers)
        : request(app).post(`/api/real-estate/admin/${report._id}/approve`).set(headers);
      const decline = () => request(app)
        .post(`/api/real-estate/admin/${report._id}/decline`)
        .set(headers)
        .send({ reason: "The report needs additional comparable evidence." });
      const paused = pauseRealEstateDecision(staleStatus);
      try {
        const stale = (staleStatus === "approved" ? approve() : decline())
          .then((response) => response);
        await paused.reached;
        const winner = await (staleStatus === "approved" ? decline() : approve());
        paused.release();
        const loser = await stale;
        expect(winner.status).toBe(200);
        expect(loser.status).toBe(409);
        expect(loser.body.code).toBe("REPORT_APPROVAL_DECISION_CONFLICT");
        const winnerStatus = staleStatus === "approved" ? "declined" : "approved";
        const saved = await RealEstateReport.findById(report._id).lean();
        expect(saved?.status).toBe(winnerStatus);
        expect(saved?.release_status).toBe(winnerStatus === "approved" ? "released" : "pending_release");
        expect(saved?.released_at != null).toBe(winnerStatus === "approved");
        expect(sideEffects.sendEmail).toHaveBeenCalledTimes(1);
        expect(sideEffects.notifyUser).toHaveBeenCalledTimes(1);
        expect(sideEffects.notifyUser).toHaveBeenCalledWith(expect.objectContaining({
          type: winnerStatus === "approved" ? "report_approved" : "report_declined",
        }));
      } finally {
        paused.release();
        paused.restore();
      }
    }
  );

  it("coalesces direct Real Estate declines and keeps the decision if email and push fail", async () => {
    const owner = await createAccount();
    const approver = await createAccount("admin");
    const report = await createReadyRealEstate(owner._id, approver._id);
    const headers = adminHeaders(String(approver._id));
    sideEffects.sendEmail.mockRejectedValueOnce(new Error("email unavailable"));
    sideEffects.notifyUser.mockRejectedValueOnce(new Error("push unavailable"));
    const decline = (reason: string) => request(app)
      .post(`/api/real-estate/admin/${report._id}/decline`)
      .set(headers).send({ reason });
    const originalReason = "The valuation requires better comparable evidence.";
    const responses = await Promise.all([decline(originalReason), decline(originalReason)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.filter((response) => response.body.already_processed)).toHaveLength(1);
    const saved = await RealEstateReport.findById(report._id).lean();
    expect(saved).toMatchObject({ status: "declined", decline_reason: originalReason });
    const retry = await decline("A retry must not replace the committed decline reason.");
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({ already_processed: true, decline_reason: originalReason });
    expect((await RealEstateReport.findById(report._id).lean())?.approval_processed_at).toEqual(saved?.approval_processed_at);
    expect(sideEffects.sendEmail).toHaveBeenCalledTimes(1);
    expect(sideEffects.notifyUser).toHaveBeenCalledTimes(1);
  });

  it("preserves Real Estate direct-decline role and assignment gates, including idempotent retries", async () => {
    const owner = await createAccount();
    const approver = await createAccount("admin");
    const otherAdmin = await createAccount("admin");
    const superadmin = await createAccount("superadmin");
    const report = await createReadyRealEstate(owner._id, approver._id);
    const decline = (actorId: unknown, reason: unknown = "The report requires additional supporting evidence.") => request(app)
      .post(`/api/real-estate/admin/${report._id}/decline`)
      .set(adminHeaders(String(actorId))).send({ reason });
    expect((await decline(owner._id)).status).toBe(403);
    expect((await decline(otherAdmin._id)).status).toBe(403);
    expect((await decline(approver._id, { invalid: true })).status).toBe(400);
    expect((await decline(approver._id, "Short")).status).toBe(400);
    expect((await decline(superadmin._id)).status).toBe(200);
    expect((await decline(otherAdmin._id)).status).toBe(403);
    const retry = await decline(approver._id);
    expect(retry.status).toBe(200);
    expect(retry.body.already_processed).toBe(true);
    expect(sideEffects.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale direct Real Estate decline after reassignment", async () => {
    const owner = await createAccount();
    const approver = await createAccount("admin");
    const otherAdmin = await createAccount("admin");
    const report = await createReadyRealEstate(owner._id, approver._id);
    const paused = pauseRealEstateDecision("declined");
    try {
      const stale = request(app)
        .post(`/api/real-estate/admin/${report._id}/decline`)
        .set(adminHeaders(String(approver._id)))
        .send({ reason: "This stale decision must not override reassignment." })
        .then((response) => response);
      await paused.reached;
      await RealEstateReport.updateOne({ _id: report._id }, { $set: { approval_assigned_to: otherAdmin._id } });
      paused.release();
      const response = await stale;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("REPORT_APPROVAL_DECISION_CONFLICT");
      expect((await RealEstateReport.findById(report._id).lean())?.status).toBe("pending_approval");
      expect(sideEffects.sendEmail).not.toHaveBeenCalled();
      expect(sideEffects.notifyUser).not.toHaveBeenCalled();
    } finally {
      paused.release();
      paused.restore();
    }
  });

  it("retains the Asset release-manager gate", async () => {
    const manager = await createAccount();
    const owner = await createAccount();
    const approver = await createAccount("admin");
    await User.updateOne({ _id: owner._id }, { $set: { releaseManager: manager._id } });
    const report = await createReadyAsset(owner._id, approver._id);
    const response = await request(app).patch(`/api/admin/reports/${report._id}/approve`).set(adminHeaders(String(approver._id)));
    expect(response.status).toBe(200);
    const saved = await AssetReport.findById(report._id).lean();
    expect(saved).toMatchObject({ status: "approved", release_status: "pending_release", release_assigned_source: "user_release_manager" });
    expect(String(saved?.release_assigned_to)).toBe(String(manager._id));
  });

  it("coalesces concurrent approval across both Asset approval routes", async () => {
    const owner = await createAccount();
    const approver = await createAccount("admin");
    const report = await createReadyAsset(owner._id, approver._id);

    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sideEffects.assignReleaseManager.mockImplementation(
      async (original: (...args: any[]) => Promise<any>, ...args: any[]) => {
        const result = await original(...args);
        arrivals += 1;
        if (arrivals === 2) release();
        await gate;
        return result;
      }
    );

    const direct = request(app)
      .post(`/api/asset/${report._id}/approve`)
      .set(adminHeaders(String(approver._id)))
      .then((response) => response);
    const admin = request(app)
      .patch(`/api/admin/reports/${report._id}/approve`)
      .set(adminHeaders(String(approver._id)))
      .then((response) => response);
    const responses = await Promise.all([direct, admin]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      responses.some((response) => response.body.already_processed === true ||
        response.body.data?.already_processed === true)
    ).toBe(true);
    expect((await AssetReport.findById(report._id).lean())?.status).toBe(
      "approved"
    );
    expect(sideEffects.sendReportApprovedEmail).toHaveBeenCalledTimes(1);
    expect(sideEffects.notifyUser).toHaveBeenCalledTimes(1);

    const assignedRetry = await request(app)
      .post(`/api/reports/assigned-approvals/${report._id}/approve`)
      .set(adminHeaders(String(approver._id)));
    expect(assignedRetry.status).toBe(200);
    expect(assignedRetry.body.already_processed).toBe(true);
    expect(sideEffects.sendReportApprovedEmail).toHaveBeenCalledTimes(1);
    expect(sideEffects.notifyUser).toHaveBeenCalledTimes(1);

    const opposingDecision = await request(app)
      .patch(`/api/admin/reports/${report._id}/reject`)
      .set(adminHeaders(String(approver._id)))
      .send({ note: "This must not overwrite the approval." });
    expect(opposingDecision.status).toBe(409);
    expect(opposingDecision.body.code).toBe(
      "REPORT_APPROVAL_DECISION_CONFLICT"
    );
    expect((await AssetReport.findById(report._id).lean())?.status).toBe(
      "approved"
    );
  });

  it("keeps direct Asset decline committed when email delivery fails", async () => {
    const owner = await createAccount();
    const approver = await createAccount("admin");
    const report = await createReadyAsset(owner._id, approver._id);
    sideEffects.sendReportDeclinedEmail.mockRejectedValueOnce(
      new Error("email unavailable")
    );

    const first = await request(app)
      .post(`/api/asset/${report._id}/decline`)
      .set(adminHeaders(String(approver._id)))
      .send({ reason: "The valuation evidence needs additional detail." });
    expect(first.status).toBe(200);

    const retry = await request(app)
      .post(`/api/asset/${report._id}/decline`)
      .set(adminHeaders(String(approver._id)))
      .send({ reason: "The valuation evidence needs additional detail." });
    expect(retry.status).toBe(200);
    expect(retry.body.data.already_processed).toBe(true);
    expect(sideEffects.sendReportDeclinedEmail).toHaveBeenCalledTimes(1);
    expect(sideEffects.notifyUser).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale approval overwrite a concurrent rejection", async () => {
    const owner = await createAccount();
    const approver = await createAccount("admin");
    const report = await createReadyAsset(owner._id, approver._id);

    let approvalReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      approvalReached = resolve;
    });
    let releaseApproval!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    sideEffects.assignReleaseManager.mockImplementationOnce(
      async (original: (...args: any[]) => Promise<any>, ...args: any[]) => {
        const result = await original(...args);
        approvalReached();
        await gate;
        return result;
      }
    );

    const staleApproval = request(app)
      .post(`/api/asset/${report._id}/approve`)
      .set(adminHeaders(String(approver._id)))
      .then((response) => response);
    await reached;
    const rejection = await request(app)
      .patch(`/api/admin/reports/${report._id}/reject`)
      .set(adminHeaders(String(approver._id)))
      .send({ note: "Reject while the stale approval tab is still open." });
    releaseApproval();
    const approval = await staleApproval;

    expect(rejection.status).toBe(200);
    expect(approval.status).toBe(409);
    expect(approval.body.code).toBe("REPORT_APPROVAL_DECISION_CONFLICT");
    expect((await AssetReport.findById(report._id).lean())?.status).toBe(
      "declined"
    );
    expect(sideEffects.sendReportApprovedEmail).not.toHaveBeenCalled();
    expect(sideEffects.sendReportDeclinedEmail).toHaveBeenCalledTimes(1);
    expect(sideEffects.notifyUser).toHaveBeenCalledTimes(1);
  });

  it("approves an assigned Lot Listing once and publishes its preview files", async () => {
    const owner = await createAccount();
    const approver = await createAccount("admin");
    const previewFiles = {
      spec_pdf: "https://files.example/lot-cr.pdf",
      schedule_a_pdf: "https://files.example/lot-schedule-a.pdf",
      cr_docx: "https://files.example/lot-cr.docx",
      excel: "https://files.example/lot-report.xlsx",
      images: "https://files.example/lot-images.zip",
    };
    const listing = await LotListing.create({
      user: owner._id,
      approval_assigned_to: approver._id,
      contract_no: "LOT-APPROVAL-CAS-001",
      sales_date: new Date("2026-09-01T00:00:00.000Z"),
      location: "Regina, SK",
      imageUrls: [],
      videoUrls: [],
      lots: [],
      status: "pending_approval",
      job_status: "done",
      valuation_methods: ["FML"],
      preview_data: {
        contract_no: "LOT-APPROVAL-CAS-001",
        location: "Regina, SK",
        valuation_methods: ["FML"],
        lots: [],
      },
      preview_files: previewFiles,
    });

    const first = await request(app)
      .post(`/api/reports/assigned-approvals/${listing._id}/approve`)
      .set(adminHeaders(String(approver._id)));
    const retry = await request(app)
      .post(`/api/reports/assigned-approvals/${listing._id}/approve`)
      .set(adminHeaders(String(approver._id)));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.already_processed).toBe(true);
    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted.status).toBe("approved");
    expect(persisted.files).toMatchObject(previewFiles);
    expect(sideEffects.sendEmail).toHaveBeenCalledTimes(1);
    expect(sideEffects.notifyUser).toHaveBeenCalledTimes(1);
  });

  it.each(["Asset", "RealEstate", "Salvage"] as const)("claims a legacy %s output group once and makes retries side-effect free", async (reportType) => {
    const owner = await createAccount();
    const approver = await createAccount("admin");
    if (reportType !== "Asset") {
      const manager = await createAccount();
      await User.updateOne({ _id: owner._id }, { $set: { releaseManager: manager._id } });
    }
    const parentReportId = new mongoose.Types.ObjectId();
    const common = {
      user: owner._id,
      report: parentReportId,
      reportType,
      reportModel: `${reportType}Report`,
      address: "Legacy report",
      fairMarketValue: "CA$1,000",
      approvalStatus: "pending" as const,
      approval_assigned_to: approver._id,
    };
    const [docx] = await PdfReport.create([
      {
        ...common,
        fileType: "docx",
        filename: "report.docx",
        filePath: "reports/report.docx",
      },
      {
        ...common,
        fileType: "xlsx",
        filename: "report.xlsx",
        filePath: "reports/report.xlsx",
      },
      {
        ...common,
        fileType: "images",
        filename: "images.zip",
        imagesFolderPath: "reports/images.zip",
      },
    ]);

    const first = await request(app)
      .patch(`/api/admin/reports/${docx._id}/approve`)
      .set(adminHeaders(String(approver._id)));
    const retry = await request(app)
      .patch(`/api/admin/reports/${docx._id}/approve`)
      .set(adminHeaders(String(approver._id)));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.already_processed).toBe(true);
    expect(
      await PdfReport.countDocuments({
        report: parentReportId,
        approvalStatus: "approved",
      })
    ).toBe(3);
    expect(await PdfReport.countDocuments({ report: parentReportId, release_status: "released" })).toBe(3);
    if (reportType !== "Asset") {
      expect(await PdfReport.countDocuments({ report: parentReportId, released_by: approver._id, release_assigned_source: "auto_released", release_assigned_to: null })).toBe(3);
    }
    expect(sideEffects.sendEmail).toHaveBeenCalledTimes(1);

    const opposingDecision = await request(app)
      .patch(`/api/admin/reports/${docx._id}/reject`)
      .set(adminHeaders(String(approver._id)))
      .send({ note: "This must not replace an approved group." });
    expect(opposingDecision.status).toBe(409);
  });
});
