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
let PdfReport: typeof import("../src/models/pdfReport.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];

function adminHeaders(id: string) {
  return {
    Authorization: `Bearer ${jwt.sign(
      { id, role: "admin" },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    )}`,
  };
}

async function createAccount(
  email: string,
  username: string,
  companyName: string,
  role: "user" | "admin" | "superadmin" = "user"
) {
  return User.create({
    email,
    username,
    companyName,
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
    role,
  });
}

async function createApprovedReport(userId: mongoose.Types.ObjectId, contractNo: string) {
  return AssetReport.create({
    user: userId,
    grouping_mode: "single_lot",
    imageUrls: [],
    lots: [],
    status: "approved",
    contract_no: contractNo,
    preview_data: { client_name: contractNo, contract_no: contractNo },
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: PdfReport } = await import("../src/models/pdfReport.model.js"));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("approved report creator search", () => {
  it("matches partial creator names, companies, and emails without interpreting regex", async () => {
    const admin = await createAccount(
      "reports-admin@example.test",
      "reports-admin",
      "Asset Insight",
      "admin"
    );
    const northstar = await createAccount(
      "maya+reports@northstar.example",
      "maya-patel",
      "Northstar Auctions"
    );
    const ridgeview = await createAccount(
      "olivia@ridgeview.example",
      "olivia-chen",
      "Ridgeview Valuations"
    );
    await Promise.all([
      createApprovedReport(northstar._id, "NORTH-001"),
      createApprovedReport(ridgeview._id, "RIDGE-001"),
    ]);

    for (const [creatorSearch, expectedContract] of [
      ["maya", "NORTH-001"],
      ["northstar auctions", "NORTH-001"],
      ["maya+reports@", "NORTH-001"],
      ["ridgeview", "RIDGE-001"],
    ]) {
      const response = await request(app)
        .get("/api/admin/reports")
        .set(adminHeaders(String(admin._id)))
        .query({ approvalStatus: "approved", userEmail: creatorSearch });

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(1);
      expect(response.body.items[0]?.contract_no).toBe(expectedContract);
    }

    const escaped = await request(app)
      .get("/api/admin/reports")
      .set(adminHeaders(String(admin._id)))
      .query({ approvalStatus: "approved", userEmail: ".*" });
    expect(escaped.status).toBe(200);
    expect(escaped.body.total).toBe(0);
  });
});

describe.sequential("admin report download state", () => {
  it("returns a stable assigned-approver reason for pending reports", async () => {
    const superadmin = await createAccount(
      "workflow-superadmin@example.test",
      "workflow-superadmin",
      "Asset Insight",
      "superadmin"
    );
    const creator = await createAccount(
      "workflow-owner@example.test",
      "workflow-owner",
      "Northstar Auctions"
    );
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "pending_approval",
      approval_assigned_to: superadmin._id,
      contract_no: "PENDING-APPROVAL-001",
      preview_data: {
        client_name: "Pending approval",
        contract_no: "PENDING-APPROVAL-001",
      },
      preview_files: {
        docx: "https://files.example/report.docx",
        excel: "https://files.example/report.xlsx",
        images: "https://files.example/images.zip",
      },
    });

    const response = await request(app)
      .get("/api/admin/reports")
      .set(adminHeaders(String(superadmin._id)))
      .query({
        approvalStatus: "pending",
        contractNo: "PENDING-APPROVAL-001",
      });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items[0]).toMatchObject({
      _id: String(report._id),
      approvalStatus: "pending",
      downloadable: false,
      download_access: {
        allowed: false,
        code: "AWAITING_APPROVAL",
      },
    });
    expect(response.body.items[0].download_access.message).toContain(
      "assigned approver"
    );
  });

  it("hides direct files and explains when an approved report awaits release", async () => {
    const admin = await createAccount(
      "release-admin@example.test",
      "release-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "release-owner@example.test",
      "release-owner",
      "Ridgeview"
    );
    await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      release_status: "pending_release",
      contract_no: "PENDING-RELEASE-001",
      preview_data: {
        client_name: "Pending release",
        contract_no: "PENDING-RELEASE-001",
      },
      preview_files: {
        docx: "https://files.example/report.docx",
        excel: "https://files.example/report.xlsx",
        images: "https://files.example/images.zip",
      },
    });

    const response = await request(app)
      .get("/api/admin/reports")
      .set(adminHeaders(String(admin._id)))
      .query({
        approvalStatus: "approved",
        contractNo: "PENDING-RELEASE-001",
      });

    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({
      downloadable: false,
      preview_files: {},
      download_access: {
        allowed: false,
        code: "AWAITING_RELEASE",
      },
    });
  });

  it("marks a released CR-only Asset as missing its required files", async () => {
    const admin = await createAccount(
      "partial-admin@example.test",
      "partial-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "partial-owner@example.test",
      "partial-owner",
      "Northstar"
    );
    await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      release_status: "released",
      contract_no: "CR-ONLY-001",
      preview_data: {
        client_name: "CR only",
        contract_no: "CR-ONLY-001",
      },
      preview_files: {
        spec_pdf: "https://files.example/cr.pdf",
        cr_docx: "https://files.example/cr.docx",
      },
    });

    const response = await request(app)
      .get("/api/admin/reports")
      .set(adminHeaders(String(admin._id)))
      .query({
        approvalStatus: "approved",
        contractNo: "CR-ONLY-001",
      });

    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({
      downloadable: false,
      download_access: {
        allowed: false,
        code: "FILES_UNAVAILABLE",
      },
      files_ready: false,
      generation_state: "error",
      workflow_stage: "error",
    });
  });

  it("refuses to release unapproved or incomplete reports", async () => {
    const admin = await createAccount(
      "release-guard-admin@example.test",
      "release-guard-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "release-guard-owner@example.test",
      "release-guard-owner",
      "Northstar"
    );
    const pending = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "pending_approval",
      preview_files: {
        docx: "https://files.example/report.docx",
        excel: "https://files.example/report.xlsx",
        images: "https://files.example/images.zip",
      },
    });
    const incomplete = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      release_status: "pending_release",
      preview_files: {
        spec_pdf: "https://files.example/cr.pdf",
        cr_docx: "https://files.example/cr.docx",
      },
    });

    const pendingResponse = await request(app)
      .post(`/api/admin/reports/${pending._id}/release`)
      .set(adminHeaders(String(admin._id)));
    expect(pendingResponse.status).toBe(409);
    expect(pendingResponse.body.code).toBe("AWAITING_APPROVAL");

    const incompleteResponse = await request(app)
      .post(`/api/admin/reports/${incomplete._id}/release`)
      .set(adminHeaders(String(admin._id)));
    expect(incompleteResponse.status).toBe(409);
    expect(incompleteResponse.body.code).toBe("FILES_UNAVAILABLE");
  });

  it("keeps an incomplete report pending when an approver tries to approve it", async () => {
    const admin = await createAccount(
      "approval-guard-admin@example.test",
      "approval-guard-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "approval-guard-owner@example.test",
      "approval-guard-owner",
      "Northstar"
    );
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "pending_approval",
      contract_no: "INCOMPLETE-APPROVAL-001",
      preview_files: {
        spec_pdf: "https://files.example/cr.pdf",
        cr_docx: "https://files.example/cr.docx",
      },
    });

    const response = await request(app)
      .patch(`/api/admin/reports/${report._id}/approve`)
      .set(adminHeaders(String(admin._id)));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("FILES_UNAVAILABLE");

    const persisted = await AssetReport.findById(report._id).lean();
    expect(persisted?.status).toBe("pending_approval");
    expect(persisted?.release_status).toBeUndefined();
  });

  it("keeps a regenerating report pending even when stale file URLs exist", async () => {
    const admin = await createAccount(
      "generation-guard-admin@example.test",
      "generation-guard-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "generation-guard-owner@example.test",
      "generation-guard-owner",
      "Northstar"
    );
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "pending_approval",
      contract_no: "REGENERATING-APPROVAL-001",
      job_status: "processing",
      files_regenerating: true,
      preview_files: {
        docx: "https://files.example/old-report.docx",
        excel: "https://files.example/old-report.xlsx",
        images: "https://files.example/old-images.zip",
      },
    });

    const response = await request(app)
      .patch(`/api/admin/reports/${report._id}/approve`)
      .set(adminHeaders(String(admin._id)));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("FILES_GENERATING");

    const persisted = await AssetReport.findById(report._id).lean();
    expect(persisted?.status).toBe("pending_approval");
    expect(persisted?.release_status).toBeUndefined();
  });

  it("does not approve a partial legacy report group", async () => {
    const admin = await createAccount(
      "legacy-guard-admin@example.test",
      "legacy-guard-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "legacy-guard-owner@example.test",
      "legacy-guard-owner",
      "Northstar"
    );
    const parentReportId = new mongoose.Types.ObjectId();
    const pdf = await PdfReport.create({
      user: creator._id,
      report: parentReportId,
      reportType: "Asset",
      reportModel: "AssetReport",
      fileType: "pdf",
      filePath: "reports/partial.pdf",
      filename: "partial.pdf",
      address: "Partial legacy report",
      fairMarketValue: "CA$1,000",
      approvalStatus: "pending",
    });

    const response = await request(app)
      .patch(`/api/admin/reports/${pdf._id}/approve`)
      .set(adminHeaders(String(admin._id)));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("FILES_UNAVAILABLE");

    const persisted = await PdfReport.findById(pdf._id).lean();
    expect(persisted?.approvalStatus).toBe("pending");
    expect(persisted?.release_status).toBeUndefined();
  });

  it("labels a released partial legacy group as files unavailable", async () => {
    const admin = await createAccount(
      "legacy-state-admin@example.test",
      "legacy-state-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "legacy-state-owner@example.test",
      "legacy-state-owner",
      "Northstar"
    );
    const parentReportId = new mongoose.Types.ObjectId();
    await PdfReport.create({
      user: creator._id,
      report: parentReportId,
      reportType: "Asset",
      reportModel: "AssetReport",
      fileType: "pdf",
      filePath: "reports/partial-released.pdf",
      filename: "partial-released.pdf",
      address: "Partial released legacy report",
      fairMarketValue: "CA$1,000",
      contract_no: "LEGACY-PARTIAL-001",
      approvalStatus: "approved",
      release_status: "released",
    });

    const response = await request(app)
      .get("/api/admin/reports")
      .set(adminHeaders(String(admin._id)))
      .query({
        approvalStatus: "approved",
        contractNo: "LEGACY-PARTIAL-001",
      });

    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({
      downloadable: false,
      files_ready: false,
      generation_state: "error",
      download_access: {
        allowed: false,
        code: "FILES_UNAVAILABLE",
      },
    });
  });
});

describe.sequential("admin Excel Condition Report editor", () => {
  it("returns structured tag-free rows, saves them, and rejects stale revisions", async () => {
    const admin = await createAccount(
      "excel-admin@example.test",
      "excel-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "creator@example.test",
      "report-creator",
      "Northstar Auctions"
    );
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: ["https://images.sellsnap.store/uploads/asset/excavator.jpg"],
      status: "approved",
      contract_no: "EXCEL-001",
      include_damage_analysis: true,
      lots: [
        {
          lot_id: "lot-1001",
          lot_number: "1001",
          title: "Mini excavator",
          description: "Mini excavator",
          categories: "Mini Excavators",
          image_indexes: [0],
          condition_report_specs: {
            "Engine Manufacturer": "Isuzu",
            "Engine Model": "Isuzu",
            Hours: "2,458 Hr",
          },
          damage_analysis: "Scratch on boom",
        },
      ],
      preview_data: {
        contract_no: "EXCEL-001",
        include_damage_analysis: true,
        lots: [
          {
            lot_id: "lot-1001",
            lot_number: "1001",
            title: "Mini excavator",
            description: "Mini excavator",
            categories: "Mini Excavators",
            image_indexes: [0],
            condition_report_specs: {
              "Engine Manufacturer": "Isuzu",
              "Engine Model": "Isuzu",
              Hours: "2,458 Hr",
            },
            damage_analysis: "Scratch on boom",
          },
        ],
      },
    });

    const loaded = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(loaded.status).toBe(200);
    expect(loaded.body.data.rows).toHaveLength(1);
    expect(loaded.body.data.rows[0].title).toBe("Mini excavator");
    expect(JSON.stringify(loaded.body.data.rows[0].specs)).not.toContain("<p>");
    expect(
      loaded.body.data.rows[0].specs.filter(
        (spec: any) => /engine model/i.test(spec.field) && spec.value
      )
    ).toHaveLength(0);

    const revision = loaded.body.data.revision;
    const rows = loaded.body.data.rows.map((row: any) => ({
      ...row,
      title: "Edited mini excavator",
      specs: row.specs
        .map((spec: any) =>
          /engine manufacturer/i.test(spec.field)
            ? { ...spec, value: "Yanmar" }
            : spec
        )
        .reverse(),
    }));
    const saved = await request(app)
      .patch(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)))
      .send({ revision, rows });
    expect(saved.status).toBe(200);
    expect(saved.body.data.rows[0].title).toBe("Edited mini excavator");
    expect(saved.body.data.rows[0].specs.map((spec: any) => spec.field)).toEqual(
      rows[0].specs.map((spec: any) => spec.field)
    );

    const reloaded = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.data.rows[0].specs.map((spec: any) => spec.field)).toEqual(
      rows[0].specs.map((spec: any) => spec.field)
    );

    const persisted = await AssetReport.findById(report._id).lean();
    expect(
      (persisted?.preview_data as any).lots[0].condition_report_specs_custom_order
    ).toEqual(rows[0].specs.map((spec: any) => spec.field));

    const stale = await request(app)
      .patch(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)))
      .send({ revision, rows });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("REPORT_REVISION_CHANGED");
  });

  it("preserves an edited Running Condition value and its custom position", async () => {
    const admin = await createAccount(
      "running-condition-admin@example.test",
      "running-condition-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "running-condition-owner@example.test",
      "running-condition-owner",
      "Northstar Auctions"
    );
    const lot = {
      lot_id: "running-condition-lot",
      lot_number: "42",
      title: "Mini excavator",
      description: "Mini excavator",
      categories: "Excavators",
      condition_report_selections: {
        condition: "N/A",
        completeness: "N/A",
        legal: "N/A",
      },
      condition_report_specs: {
        "Has Key": "No",
        "Serial Number": "EX-42",
      },
    };
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      status: "approved",
      contract_no: "RUNNING-CONDITION-001",
      lots: [lot],
      preview_data: { lots: [lot] },
    });

    const loaded = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(loaded.status).toBe(200);

    const currentSpecs = loaded.body.data.rows[0].specs as any[];
    const runningCondition = currentSpecs.find(
      (spec: any) => spec.field === "Running Condition"
    );
    expect(runningCondition?.value).toBe("");
    const withoutRunningCondition = currentSpecs.filter(
      (spec: any) => spec.field !== "Running Condition"
    );
    const hasKeyIndex = withoutRunningCondition.findIndex(
      (spec: any) => spec.field === "Has Key"
    );
    const editedSpecs = [
      ...withoutRunningCondition.slice(0, hasKeyIndex + 1),
      { ...runningCondition, value: "Unverified Running Condition" },
      ...withoutRunningCondition.slice(hasKeyIndex + 1),
    ];
    const rows = [
      {
        ...loaded.body.data.rows[0],
        specs: editedSpecs,
      },
    ];

    const saved = await request(app)
      .patch(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)))
      .send({ revision: loaded.body.data.revision, rows });
    expect(saved.status).toBe(200);
    const savedSpecs = saved.body.data.rows[0].specs as any[];
    const savedRunningIndex = savedSpecs.findIndex(
      (spec: any) => spec.field === "Running Condition"
    );
    expect(savedSpecs[savedRunningIndex]?.value).toBe(
      "Unverified Running Condition"
    );
    expect(savedSpecs[savedRunningIndex - 1]?.field).toBe("Has Key");

    const persisted = await AssetReport.findById(report._id).lean();
    const persistedLot = (persisted?.preview_data as any).lots[0];
    expect(persistedLot.condition_report_selections.condition).toBe(
      "Unverified Running Condition"
    );
    expect(persistedLot.condition_report_specs["Running Condition"]).toBe(
      "Unverified Running Condition"
    );

    const reloaded = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(reloaded.status).toBe(200);
    const reloadedSpecs = reloaded.body.data.rows[0].specs as any[];
    const reloadedRunningIndex = reloadedSpecs.findIndex(
      (spec: any) => spec.field === "Running Condition"
    );
    expect(reloadedSpecs[reloadedRunningIndex]?.value).toBe(
      "Unverified Running Condition"
    );
    expect(reloadedSpecs[reloadedRunningIndex - 1]?.field).toBe("Has Key");
  });

  it("preserves a blank Running Condition and its custom position", async () => {
    const admin = await createAccount(
      "blank-running-condition-admin@example.test",
      "blank-running-condition-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "blank-running-condition-owner@example.test",
      "blank-running-condition-owner",
      "Northstar Auctions"
    );
    const lot = {
      lot_id: "blank-running-condition-lot",
      lot_number: "43",
      title: "Mini excavator",
      description: "Mini excavator",
      categories: "Excavators",
      condition_report_selections: {
        condition: "Starts and Runs",
        completeness: "N/A",
        legal: "N/A",
      },
      condition_report_specs: {
        "Has Key": "No",
        "Serial Number": "EX-43",
      },
    };
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      status: "approved",
      contract_no: "RUNNING-CONDITION-BLANK-001",
      lots: [lot],
      preview_data: { lots: [lot] },
    });

    const loaded = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(loaded.status).toBe(200);

    const currentSpecs = loaded.body.data.rows[0].specs as any[];
    const runningCondition = currentSpecs.find(
      (spec: any) => spec.field === "Running Condition"
    );
    expect(runningCondition?.value).toBeTruthy();
    const withoutRunningCondition = currentSpecs.filter(
      (spec: any) => spec.field !== "Running Condition"
    );
    const hasKeyIndex = withoutRunningCondition.findIndex(
      (spec: any) => spec.field === "Has Key"
    );
    const editedSpecs = [
      ...withoutRunningCondition.slice(0, hasKeyIndex + 1),
      { ...runningCondition, value: "" },
      ...withoutRunningCondition.slice(hasKeyIndex + 1),
    ];

    const saved = await request(app)
      .patch(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)))
      .send({
        revision: loaded.body.data.revision,
        rows: [{ ...loaded.body.data.rows[0], specs: editedSpecs }],
      });
    expect(saved.status).toBe(200);
    const savedSpecs = saved.body.data.rows[0].specs as any[];
    const savedRunningIndex = savedSpecs.findIndex(
      (spec: any) => spec.field === "Running Condition"
    );
    expect(savedSpecs[savedRunningIndex]?.value).toBe("");
    expect(savedSpecs[savedRunningIndex - 1]?.field).toBe("Has Key");

    const persisted = await AssetReport.findById(report._id).lean();
    const persistedLot = (persisted?.preview_data as any).lots[0];
    expect(persistedLot.condition_report_selections.condition).toBe("N/A");
    expect(persistedLot.condition_report_specs).not.toHaveProperty(
      "Running Condition"
    );
    const persistedRunningIndex =
      persistedLot.condition_report_specs_custom_order.indexOf("Running Condition");
    expect(
      persistedLot.condition_report_specs_custom_order[persistedRunningIndex - 1]
    ).toBe("Has Key");

    const reloaded = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(reloaded.status).toBe(200);
    const reloadedSpecs = reloaded.body.data.rows[0].specs as any[];
    const reloadedRunningIndex = reloadedSpecs.findIndex(
      (spec: any) => spec.field === "Running Condition"
    );
    expect(reloadedSpecs[reloadedRunningIndex]?.value).toBe("");
    expect(reloadedSpecs[reloadedRunningIndex - 1]?.field).toBe("Has Key");
  });

  it("keeps a deleted Running Condition absent after save and reload", async () => {
    const admin = await createAccount(
      "deleted-running-condition-admin@example.test",
      "deleted-running-condition-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "deleted-running-condition-owner@example.test",
      "deleted-running-condition-owner",
      "Northstar Auctions"
    );
    const lot = {
      lot_id: "deleted-running-condition-lot",
      lot_number: "44",
      title: "Mini excavator",
      description: "Mini excavator",
      categories: "Excavators",
      condition_report_selections: {
        condition: "Unverified Running Condition",
        completeness: "N/A",
        legal: "N/A",
      },
      condition_report_specs: {
        "Has Key": "No",
        "Serial Number": "EX-44",
      },
    };
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      status: "approved",
      contract_no: "RUNNING-CONDITION-DELETED-001",
      lots: [lot],
      preview_data: { lots: [lot] },
    });

    const loaded = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(loaded.status).toBe(200);
    const rows = [
      {
        ...loaded.body.data.rows[0],
        specs: loaded.body.data.rows[0].specs.map((spec: any) =>
          spec.field === "Running Condition" ? { ...spec, deleted: true } : spec
        ),
      },
    ];

    const saved = await request(app)
      .patch(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)))
      .send({ revision: loaded.body.data.revision, rows });
    expect(saved.status).toBe(200);
    expect(
      saved.body.data.rows[0].specs.some(
        (spec: any) => spec.field === "Running Condition"
      )
    ).toBe(false);

    const persisted = await AssetReport.findById(report._id).lean();
    const persistedLot = (persisted?.preview_data as any).lots[0];
    expect(persistedLot.condition_report_selections.condition).toBe("N/A");
    expect(persistedLot.condition_report_specs_deleted).toContain(
      "Running Condition"
    );
    expect(persistedLot.condition_report_specs_custom_order).not.toContain(
      "Running Condition"
    );

    const reloaded = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(reloaded.status).toBe(200);
    expect(
      reloaded.body.data.rows[0].specs.some(
        (spec: any) => spec.field === "Running Condition"
      )
    ).toBe(false);
  });

  it("applies one full CR Notes selection to every top-level lot without changing lot content", async () => {
    const admin = await createAccount(
      "bulk-notes-admin@example.test",
      "bulk-notes-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "bulk-notes-owner@example.test",
      "bulk-notes-owner",
      "Northstar Auctions"
    );
    const lots = [
      {
        lot_id: "bulk-lot-1",
        lot_number: "101",
        title: "Crawler tractor",
        description: "Crawler tractor",
        categories: "Crawler Tractors",
        image_indexes: [],
        condition_report_specs: {
          Manufacturer: "Caterpillar",
          Model: "D6",
        },
        damage_analysis: "Left track shows wear",
      },
      {
        lot_id: "bulk-lot-2",
        lot_number: "202",
        title: "Wheel loader",
        description: "Wheel loader",
        categories: "Wheel Loaders",
        image_indexes: [],
        condition_report_specs: {
          Manufacturer: "Volvo",
          Model: "L90H",
        },
        damage_analysis: "Scratch on right lift arm",
      },
    ];
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      status: "approved",
      contract_no: "BULK-NOTES-001",
      include_damage_analysis: true,
      lots,
      preview_data: {
        contract_no: "BULK-NOTES-001",
        include_damage_analysis: true,
        lots,
      },
    });
    const beforePersisted = await AssetReport.findById(report._id).lean();
    const beforeLotContent = (beforePersisted?.preview_data as any).lots.map(
      (lot: any) => ({
        condition_report_specs: lot.condition_report_specs,
        damage_analysis: lot.damage_analysis,
      })
    );

    const loaded = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(loaded.status).toBe(200);
    expect(loaded.body.data.rows).toHaveLength(2);

    const notesForEveryLot = {
      smallsOnsite: true,
      smallsOffsite: false,
      rollingStockOnsite: false,
      rollingStockOffsite: true,
      customText: "<p><strong>Applies to every lot</strong></p>",
      unreserved: true,
      closingDate: "2026-08-15",
      closingTime: "2:30",
      closingTimePeriod: "PM",
      bidIncrement: 25,
      openingBid: 100,
    };
    const rows = loaded.body.data.rows.map((row: any) => ({
      ...row,
      disclaimers: notesForEveryLot,
    }));
    const saved = await request(app)
      .patch(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)))
      .send({ revision: loaded.body.data.revision, rows });

    expect(saved.status).toBe(200);
    expect(saved.body.data.rows).toHaveLength(2);
    expect(
      saved.body.data.rows.map((row: any) => row.disclaimers)
    ).toEqual([notesForEveryLot, notesForEveryLot]);
    expect(
      saved.body.data.rows.map((row: any) => ({
        specs: row.specs,
        damageAnalysis: row.damageAnalysis,
      }))
    ).toEqual(
      loaded.body.data.rows.map((row: any) => ({
        specs: row.specs,
        damageAnalysis: row.damageAnalysis,
      }))
    );

    const persisted = await AssetReport.findById(report._id).lean();
    expect((persisted?.preview_data as any).cr_disclaimers_by_lot).toEqual({
      "bulk-lot-1": notesForEveryLot,
      "bulk-lot-2": notesForEveryLot,
    });
    expect(
      (persisted?.preview_data as any).lots.map((lot: any) => ({
        condition_report_specs: lot.condition_report_specs,
        damage_analysis: lot.damage_analysis,
      }))
    ).toEqual(beforeLotContent);
    expect(
      (persisted?.lots as any[]).map((lot: any) => ({
        condition_report_specs: lot.condition_report_specs,
        damage_analysis: lot.damage_analysis,
      }))
    ).toEqual(beforeLotContent);

    const reloaded = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(reloaded.status).toBe(200);
    expect(
      reloaded.body.data.rows.map((row: any) => row.disclaimers)
    ).toEqual([notesForEveryLot, notesForEveryLot]);
    expect(
      reloaded.body.data.rows.map((row: any) => ({
        specs: row.specs,
        damageAnalysis: row.damageAnalysis,
      }))
    ).toEqual(
      loaded.body.data.rows.map((row: any) => ({
        specs: row.specs,
        damageAnalysis: row.damageAnalysis,
      }))
    );
  });

  it("rejects non-admin access and non-approved reports", async () => {
    const creator = await createAccount(
      "editor-user@example.test",
      "editor-user",
      "Ridgeview"
    );
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "preview",
      preview_data: { lots: [] },
    });

    const userResponse = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(creator._id)));
    expect(userResponse.status).toBe(403);

    const admin = await createAccount(
      "another-admin@example.test",
      "another-admin",
      "Asset Insight",
      "superadmin"
    );
    const previewResponse = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(previewResponse.status).toBe(400);
    expect(previewResponse.body.code).toBe("REPORT_NOT_APPROVED");
  });

  it("updates nested catalogue rows and shares a changed disclaimer across the parent lot", async () => {
    const admin = await createAccount(
      "catalogue-admin@example.test",
      "catalogue-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "catalogue-owner@example.test",
      "catalogue-owner",
      "Northstar"
    );
    const lot = {
      lot_id: "catalogue-1",
      lot_number: "1005",
      title: "Catalogue",
      description: "Two catalogue items",
      image_indexes: [],
      items: [
        { title: "Item A", condition_report_specs: { Colour: "Red" } },
        { title: "Item B", condition_report_specs: { Colour: "Blue" } },
      ],
    };
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "catalogue",
      imageUrls: [],
      status: "approved",
      lots: [lot],
      preview_data: { include_damage_analysis: true, lots: [lot] },
    });
    const loaded = await request(app)
      .get(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)));
    expect(loaded.status).toBe(200);
    expect(loaded.body.data.rows).toHaveLength(2);

    const rows = loaded.body.data.rows.map((row: any, index: number) =>
      index === 0
        ? {
            ...row,
            title: "Edited Item A",
            disclaimers: { ...row.disclaimers, unreserved: true },
          }
        : row
    );
    const saved = await request(app)
      .patch(`/api/admin/reports/${report._id}/excel-condition-reports`)
      .set(adminHeaders(String(admin._id)))
      .send({ revision: loaded.body.data.revision, rows });
    expect(saved.status).toBe(200);
    expect(saved.body.data.rows[0].title).toBe("Edited Item A");
    expect(saved.body.data.rows[0].disclaimers.unreserved).toBe(true);
    expect(saved.body.data.rows[1].disclaimers.unreserved).toBe(true);
  });

  it("keeps hidden draft previews out of admin CR and regeneration actions", async () => {
    const admin = await createAccount(
      "hidden-draft-admin@example.test",
      "hidden-draft-admin",
      "Asset Insight",
      "admin"
    );
    const creator = await createAccount(
      "hidden-draft-owner@example.test",
      "hidden-draft-owner",
      "Northstar Auctions"
    );
    const draftPreview = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      contract_no: "HIDDEN-DRAFT-001",
      is_draft_preview: true,
      preview_data: {
        contract_no: "HIDDEN-DRAFT-001",
        lots: [],
      },
    });

    const [loaded, saved, rerun] = await Promise.all([
      request(app)
        .get(`/api/admin/reports/${draftPreview._id}/cr-disclaimers`)
        .set(adminHeaders(String(admin._id))),
      request(app)
        .patch(`/api/admin/reports/${draftPreview._id}/cr-disclaimers`)
        .set(adminHeaders(String(admin._id)))
        .send({ unreserved: true }),
      request(app)
        .post(`/api/admin/reports/${draftPreview._id}/rerun-excel-cr`)
        .set(adminHeaders(String(admin._id))),
    ]);

    expect(loaded.status).toBe(404);
    expect(saved.status).toBe(404);
    expect(rerun.status).toBe(404);
    await expect(
      ReportJob.countDocuments({
        reportId: String(draftPreview._id),
        type: "asset-excel-cr-files",
      })
    ).resolves.toBe(0);

    const persisted = await AssetReport.findById(draftPreview._id).lean();
    expect((persisted?.preview_data as any)?.cr_disclaimers).toBeUndefined();
  });
});

describe.sequential("saved report photo deletion", () => {
  it("compacts root images, remaps indexes, and queues first-party storage deletion", async () => {
    const creator = await createAccount(
      "photo-owner@example.test",
      "photo-owner",
      "Northstar Auctions"
    );
    const removedUrl = "https://assetinsight.test/uploads/asset/remove.jpg";
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [
        "https://assetinsight.test/uploads/asset/keep-1.jpg",
        removedUrl,
        "https://assetinsight.test/uploads/asset/keep-2.jpg",
      ],
      status: "preview",
      lots: [
        {
          lot_id: "lot-1",
          lot_number: "1001",
          title: "Equipment",
          description: "Equipment",
          image_indexes: [0, 2],
        },
      ],
      preview_data: {
        deleted_image_indexes: [1],
        lots: [
          {
            lot_id: "lot-1",
            lot_number: "1001",
            title: "Equipment",
            description: "Equipment",
            image_indexes: [0, 2],
          },
        ],
      },
    });

    expect(report.imageUrls).toEqual([
      "https://assetinsight.test/uploads/asset/keep-1.jpg",
      "https://assetinsight.test/uploads/asset/keep-2.jpg",
    ]);
    expect((report.preview_data as any).lots[0].image_indexes).toEqual([0, 1]);
    expect((report.preview_data as any).deleted_image_indexes).toEqual([]);
    const job = await ReportJob.findOne({ type: "report-media-delete" }).lean();
    expect(job?.payload?.url).toBe(removedUrl);
    expect(job?.maxAttempts).toBe(5);
  });

  it("compacts legacy image metadata without queuing physical deletion", async () => {
    const creator = await createAccount(
      "legacy-photo-owner@example.test",
      "legacy-photo-owner",
      "Legacy Auctions"
    );
    const removedUrl = "https://images.sellsnap.test/uploads/asset/remove.jpg";
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [removedUrl],
      status: "preview",
      lots: [],
      preview_data: {
        deleted_image_indexes: [0],
        lots: [],
      },
    });

    expect(report.imageUrls).toEqual([]);
    expect((report.preview_data as any).deleted_image_indexes).toEqual([]);
    await expect(
      ReportJob.countDocuments({ type: "report-media-delete" })
    ).resolves.toBe(0);
  });
});
