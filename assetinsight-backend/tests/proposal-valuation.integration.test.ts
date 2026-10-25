import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import { EventEmitter } from "node:events";
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
} from "vitest";
import {
  buildDefaultAssetAdminScheduleSheet,
  calculateAssetAdminScheduleSheet,
} from "../src/service/assetAdminScheduleSheetService.js";
import {
  openProposalValuationEventStream,
  resetProposalValuationEventHubForTests,
} from "../src/service/proposalValuationRealtimeService.js";

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let PdfReport: typeof import("../src/models/pdfReport.model.js")["default"];
let saveAdminProposalValuationSheet: typeof import("../src/service/proposalValuationService.js")["saveAdminProposalValuationSheet"];
let getCanonicalProposalValuationSheet: typeof import("../src/service/proposalValuationService.js")["getCanonicalProposalValuationSheet"];
let getProposalValuationRegenerationContext: typeof import("../src/service/proposalValuationService.js")["getProposalValuationRegenerationContext"];
let getReportPreviewPayloadById: typeof import("../src/service/reportPreviewService.js")["getReportPreviewPayloadById"];
let previousDeviceEnforcement: string | undefined;

function authHeaders(id: string, role: "user" | "admin" | "superadmin" = "user") {
  return {
    Authorization: `Bearer ${jwt.sign(
      { id, role },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    )}`,
  };
}

function binaryParser(
  response: NodeJS.ReadableStream,
  callback: (error: Error | null, body?: Buffer) => void
) {
  const chunks: Buffer[] = [];
  response.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  response.on("end", () => callback(null, Buffer.concat(chunks)));
  response.on("error", (error) => callback(error as Error));
}

function proposalValuationStream(reportId: string, userId: string) {
  const req = new EventEmitter() as any;
  req.headers = {};
  req.query = {};
  req.params = { id: reportId };
  req.userId = userId;
  req.ip = "203.0.113.90";

  const res = new EventEmitter() as any;
  res.chunks = [] as string[];
  res.writableEnded = false;
  res.status = function status(code: number) {
    this.statusCode = code;
    return this;
  };
  res.setHeader = function setHeader() {};
  res.flushHeaders = function flushHeaders() {};
  res.write = function write(chunk: string) {
    this.chunks.push(String(chunk));
    return true;
  };
  res.end = function end() {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit("close");
  };
  openProposalValuationEventStream({
    req,
    res,
    reportId,
    userId,
    currentRevision: 0,
  });
  return res;
}

async function createAccount(input: {
  email: string;
  role?: "user" | "admin" | "superadmin";
  enabled?: boolean;
  verified?: boolean;
  blocked?: boolean;
}) {
  return User.create({
    email: input.email,
    username: input.email.split("@")[0],
    companyName: `${input.email.split("@")[0]} Ltd`,
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: input.verified ?? true,
    isBlocked: input.blocked ?? false,
    role: input.role || "user",
    proposalValuationEnabled: input.enabled ?? true,
  });
}

function initialSheet() {
  return calculateAssetAdminScheduleSheet({
    evaluator_columns: [{ id: "legacy", name: "Legacy evaluator" }],
    rows: [
      {
        lot_id: "lot-1",
        asset_id: "1",
        asset_category: "Excavator",
        evaluator_values: { legacy: 1_000 },
      },
    ],
    file_summary: {
      buyers_premium_basis: "uncapped",
      offer2_nmg_percent: 0.785,
      capped_threshold_percent: 0.1,
    },
  });
}

async function createReport(ownerId: mongoose.Types.ObjectId) {
  return AssetReport.create({
    user: ownerId,
    grouping_mode: "single_lot",
    imageUrls: [],
    lots: [],
    status: "approved",
    contract_no: "PV-001",
    preview_data: {
      contract_no: "PV-001",
      client_name: "Proposal Valuation Fixture",
      admin_schedule_sheet: initialSheet(),
      preview_files: {
        docx: "https://files.example/private.docx",
      },
    },
    preview_files: {
      docx: "https://files.example/private.docx",
    },
  });
}

beforeAll(async () => {
  previousDeviceEnforcement = process.env.DEVICE_APPROVAL_ENFORCEMENT;
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: PdfReport } = await import("../src/models/pdfReport.model.js"));
  ({
    getCanonicalProposalValuationSheet,
    getProposalValuationRegenerationContext,
    saveAdminProposalValuationSheet,
  } = await import("../src/service/proposalValuationService.js"));
  ({ getReportPreviewPayloadById } = await import(
    "../src/service/reportPreviewService.js"
  ));
});

beforeEach(async () => {
  resetProposalValuationEventHubForTests();
  await mongoose.connection.db!.dropDatabase();
});

afterAll(async () => {
  if (previousDeviceEnforcement === undefined) {
    delete process.env.DEVICE_APPROVAL_ENFORCEMENT;
  } else {
    process.env.DEVICE_APPROVAL_ENFORCEMENT = previousDeviceEnforcement;
  }
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("collaborative Proposal Valuation API", () => {
  it("projects average-based premiums without read writes and recalculates owner/admin saves and exports", async () => {
    const [owner, admin] = await Promise.all([
      createAccount({ email: "pv-average-owner@example.test" }),
      createAccount({ email: "pv-average-admin@example.test", role: "superadmin", enabled: false }),
    ]);
    const report = await createReport(owner._id), sheet = initialSheet();
    const ownerColumnId = "saved-owner";
    sheet.evaluator_columns.push({ id: ownerColumnId, user_id: String(owner._id), name: owner.username });
    sheet.rows[0].evaluator_values = { legacy: 1000, [ownerColumnId]: 3000 };
    // Preserve a historical high-based snapshot to prove reads project rather than migrate it.
    Object.assign(sheet.rows[0], { buyer_premium_amount: 450, total_expected_gross: 3450, allocated_value: 3450 });
    await AssetReport.updateOne({ _id: report._id }, { $set: { "preview_data.admin_schedule_sheet": sheet } });
    const before = await AssetReport.findById(report._id).lean();
    const loaded = await request(app).get(`/api/asset/${report._id}/proposal-valuation`).set(authHeaders(String(owner._id)));
    expect(loaded.status).toBe(200);
    expect(loaded.body.calculationVersion).toBe("asset-pv-v2-average-premium");
    expect(loaded.body.assetScheduleSheet.rows[0]).toMatchObject({
      buyer_premium_amount: 300, total_expected_gross: 2300, allocated_value: 2300,
      low_est_sale_value: 1000, high_est_sale_value: 3000, cleaning: 30,
    });
    expect((await getReportPreviewPayloadById(String(report._id)))?.assetScheduleSheet?.rows[0].buyer_premium_amount).toBe(300);
    const exported = await request(app).get(`/api/asset/${report._id}/proposal-valuation/export`)
      .set(authHeaders(String(owner._id))).buffer(true).parse(binaryParser);
    expect(exported.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.body as ExcelJS.Buffer);
    const detail = workbook.getWorksheet("Valuation Detail")!;
    for (const [label, expected] of [["Capped Buyer Premium", 300], ["Total Expected Gross", 2300], ["Allocated Value", 2300]] as const) {
      let column = 0;
      detail.getRow(7).eachCell((cell, index) => { if (cell.text === label) column = index; });
      expect(column).toBeGreaterThan(0);
      expect(detail.getRow(8).getCell(column).result).toBe(expected);
    }
    expect(await AssetReport.findById(report._id).lean()).toEqual(before);
    const saved = await request(app).patch(`/api/asset/${report._id}/proposal-valuation`).set(authHeaders(String(owner._id)))
      .send({ baseRevision: 0, clientMutationId: "average-owner-save", changes: [{ lotId: "lot-1", field: `evaluator_values.${ownerColumnId}`, value: 5000 }] });
    expect(saved.status).toBe(200);
    expect(saved.body.assetScheduleSheet.rows[0]).toMatchObject({ buyer_premium_amount: 450, total_expected_gross: 3450, allocated_value: 3450 });
    const adminInput = structuredClone(saved.body.assetScheduleSheet);
    adminInput.rows[0].evaluator_values[ownerColumnId] = 0;
    const adminSaved = await saveAdminProposalValuationSheet({ reportId: String(report._id), adminUserId: String(admin._id), rawSheet: adminInput, baseRevision: 1 });
    expect(adminSaved.assetScheduleSheet.rows[0]).toMatchObject({ buyer_premium_amount: 75, total_expected_gross: 575, allocated_value: 575 });
    const persisted: any = await AssetReport.findById(report._id).lean();
    expect(persisted.proposal_valuation_revision).toBe(2);
    expect(persisted.preview_data.admin_schedule_sheet.rows[0]).toMatchObject({ buyer_premium_amount: 75, total_expected_gross: 575, allocated_value: 575 });
    expect(persisted.preview_files).toEqual((before as any).preview_files);
    expect(persisted.preview_data.preview_files).toEqual((before as any).preview_data.preview_files);
  });

  it("projects the owner on a new sheet without GET writes and persists only an explicit value save", async () => {
    const owner = await createAccount({ email: "pv-default-owner@example.test" });
    const report = await createReport(owner._id);
    await AssetReport.updateOne({ _id: report._id }, { $unset: { "preview_data.admin_schedule_sheet": 1 },
      $set: { "preview_data.lots": [{ lot_id: "lot-1", title: "Owner default fixture" }] } });
    const before = await AssetReport.findById(report._id).lean();
    const first = await request(app).get(`/api/asset/${report._id}/proposal-valuation`).set(authHeaders(String(owner._id)));
    const again = await request(app).get(`/api/asset/${report._id}/proposal-valuation`).set(authHeaders(String(owner._id)));
    expect(first.status).toBe(200);
    const columnId = `pv_${owner._id}`;
    expect(first.body.assetScheduleSheet.evaluator_columns).toEqual([{ id: columnId, user_id: String(owner._id), name: owner.username, email: owner.email }]);
    expect(first.body.assetScheduleSheet.rows[0].evaluator_values).toEqual({ [columnId]: null });
    expect(first.body.participants).toContainEqual(expect.objectContaining({ id: String(owner._id), columnId, isOwner: true }));
    expect(first.body.ownerColumnId).toBe(columnId);
    expect(first.body.permissions).toMatchObject({ canEditAll: true, evaluatorColumnId: null });
    expect(again.body.assetScheduleSheet).toEqual(first.body.assetScheduleSheet);
    expect(await AssetReport.findById(report._id).lean()).toEqual(before);
    const saved = await request(app).patch(`/api/asset/${report._id}/proposal-valuation`).set(authHeaders(String(owner._id)))
      .send({ baseRevision: 0, clientMutationId: "save-owner-zero", changes: [{ lotId: "lot-1", field: `evaluator_values.${columnId}`, value: 0 }] });
    expect(saved.status).toBe(200);
    expect(saved.body.assetScheduleSheet.rows[0].evaluator_values[columnId]).toBe(0);
    const persisted: any = await AssetReport.findById(report._id).lean();
    expect(persisted.proposal_valuation_evaluators).toEqual([]);
    expect(persisted.preview_data.admin_schedule_sheet.rows[0].evaluator_values[columnId]).toBe(0);
  });

  it("retains legacy columns and exact owner-linked identity/values without inferred name matches", async () => {
    const owner = await createAccount({ email: "pv-legacy-owner@example.test" });
    const report = await createReport(owner._id);
    const sheet = initialSheet();
    sheet.evaluator_columns[0].name = owner.username;
    sheet.evaluator_columns.push({ id: "saved-owner-column", user_id: String(owner._id), name: "Old display name" });
    sheet.rows[0].evaluator_values["saved-owner-column"] = 2500;
    await AssetReport.updateOne({ _id: report._id }, { $set: { "preview_data.admin_schedule_sheet": sheet } });
    const before = await AssetReport.findById(report._id).lean();
    const response = await request(app).get(`/api/asset/${report._id}/proposal-valuation`).set(authHeaders(String(owner._id)));
    expect(response.status).toBe(200);
    expect(response.body.assetScheduleSheet.evaluator_columns).toEqual([
      { id: "legacy", name: owner.username },
      { id: "saved-owner-column", user_id: String(owner._id), name: owner.username, email: owner.email },
    ]);
    expect(response.body.assetScheduleSheet.rows[0].evaluator_values).toEqual({ legacy: 1000, "saved-owner-column": 2500 });
    expect(await AssetReport.findById(report._id).lean()).toEqual(before);
    const removed = await request(app).put(`/api/asset/${report._id}/proposal-valuation/evaluators`).set(authHeaders(String(owner._id)))
      .send({ evaluatorUserIds: [], baseRevision: 0, clientMutationId: "remove-additional-not-owner" });
    expect(removed.status).toBe(200);
    expect(removed.body.assetScheduleSheet.rows[0].evaluator_values).toEqual({ legacy: 1000, "saved-owner-column": 2500 });
    expect(removed.body.assetScheduleSheet.evaluator_columns.filter((column: any) => column.user_id === String(owner._id))).toHaveLength(1);
  });

  it("does not adopt a text-only column's values when its id collides with the owner default", async () => {
    const owner = await createAccount({ email: "pv-id-collision-owner@example.test" });
    const report = await createReport(owner._id);
    const sheet = initialSheet(), legacyId = `pv_${owner._id}`;
    sheet.evaluator_columns[0].id = legacyId;
    sheet.rows[0].evaluator_values = { [legacyId]: 900 };
    await AssetReport.updateOne({ _id: report._id }, { $set: { "preview_data.admin_schedule_sheet": sheet } });
    const response = await request(app).get(`/api/asset/${report._id}/proposal-valuation`).set(authHeaders(String(owner._id)));
    expect(response.status).toBe(200);
    const ownerColumn = response.body.assetScheduleSheet.evaluator_columns.find((column: any) => column.user_id === String(owner._id));
    expect(ownerColumn.id).not.toBe(legacyId);
    expect(response.body.assetScheduleSheet.rows[0].evaluator_values).toEqual({ [legacyId]: 900, [ownerColumn.id]: null });
  });

  it("restores the intrinsic owner column on old admin saves and rejects identity changes", async () => {
    const [owner, admin] = await Promise.all([createAccount({ email: "pv-admin-owner@example.test" }), createAccount({ email: "pv-admin-default@example.test", role: "superadmin", enabled: false })]);
    const report = await createReport(owner._id), sheet = initialSheet(), ownerId = String(owner._id);
    sheet.evaluator_columns.push({ id: "saved-owner", user_id: ownerId, name: owner.username });
    sheet.rows[0].evaluator_values["saved-owner"] = 3200;
    await AssetReport.updateOne({ _id: report._id }, { $set: { "preview_data.admin_schedule_sheet": sheet } });
    const saved = await saveAdminProposalValuationSheet({ reportId: String(report._id), adminUserId: String(admin._id), rawSheet: initialSheet(), baseRevision: 0 });
    expect(saved.assetScheduleSheet.rows[0].evaluator_values).toEqual({ legacy: 1000, "saved-owner": 3200 });
    expect(saved.ownerColumnId).toBe("saved-owner");
    expect(saved.assetScheduleSheet.evaluator_columns.find(column => column.user_id === ownerId)).toMatchObject({ id: "saved-owner", name: owner.username });
    const invalid = structuredClone(saved.assetScheduleSheet);
    invalid.evaluator_columns.find(column => column.user_id === ownerId)!.id = "replacement-id";
    await expect(saveAdminProposalValuationSheet({ reportId: String(report._id), adminUserId: String(admin._id), rawSheet: invalid, baseRevision: 1 })).rejects.toMatchObject({ statusCode: 400, code: "PROPOSAL_VALUATION_OWNER_COLUMN_INVALID" });
    const edited = structuredClone(saved.assetScheduleSheet);
    Object.assign(edited.evaluator_columns.find(column => column.user_id === ownerId)!, { name: "Spoofed", email: "spoofed@example.test" });
    edited.rows[0].evaluator_values["saved-owner"] = null;
    const cleared = await saveAdminProposalValuationSheet({ reportId: String(report._id), adminUserId: String(admin._id), rawSheet: edited, baseRevision: 1 });
    expect(cleared.assetScheduleSheet.rows[0].evaluator_values["saved-owner"]).toBeNull();
    expect(cleared.assetScheduleSheet.evaluator_columns.find(column => column.user_id === ownerId)).toMatchObject({ name: owner.username, email: owner.email });
    const persisted: any = await AssetReport.findById(report._id).lean();
    expect(persisted.proposal_valuation_evaluators).toEqual([]);
    const preview = await getReportPreviewPayloadById(String(report._id));
    expect(preview?.ownerColumnId).toBe("saved-owner");
  });

  it("keeps four additional evaluators separate from the owner and never grants them the owner column", async () => {
    const owner = await createAccount({ email: "pv-four-owner@example.test" });
    const evaluators = await Promise.all(Array.from({ length: 4 }, (_, i) => createAccount({ email: `pv-four-${i}@example.test` })));
    const report = await createReport(owner._id);
    const assigned = await request(app).put(`/api/asset/${report._id}/proposal-valuation/evaluators`).set(authHeaders(String(owner._id)))
      .send({ evaluatorUserIds: evaluators.map(user => String(user._id)), baseRevision: 0, clientMutationId: "four-plus-owner" });
    expect(assigned.status).toBe(200);
    expect(assigned.body.assetScheduleSheet.evaluator_columns.filter((column: any) => column.user_id)).toHaveLength(5);
    const forbidden = await request(app).patch(`/api/asset/${report._id}/proposal-valuation`).set(authHeaders(String(evaluators[0]._id)))
      .send({ baseRevision: 1, clientMutationId: "not-my-owner-column", changes: [{ lotId: "lot-1", field: `evaluator_values.pv_${owner._id}`, value: 77 }] });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe("PROPOSAL_VALUATION_FIELD_FORBIDDEN");
    const duplicateOwner = await request(app).put(`/api/asset/${report._id}/proposal-valuation/evaluators`).set(authHeaders(String(owner._id)))
      .send({ evaluatorUserIds: [String(owner._id)], baseRevision: 1, clientMutationId: "cannot-add-owner-twice" });
    expect(duplicateOwner.status).toBe(400);
    const persisted: any = await AssetReport.findById(report._id).lean();
    expect(persisted.proposal_valuation_evaluators).toHaveLength(4);
  });

  it("retains saved owner identity and values when the owner account is unavailable without granting access", async () => {
    const [owner, evaluator] = await Promise.all([createAccount({ email: "pv-removed-owner@example.test" }), createAccount({ email: "pv-remaining-evaluator@example.test" })]);
    const report = await createReport(owner._id), sheet = initialSheet();
    sheet.evaluator_columns.push({ id: "historical-owner", user_id: String(owner._id), name: "Saved owner" });
    sheet.rows[0].evaluator_values["historical-owner"] = 1200;
    await AssetReport.updateOne({ _id: report._id }, { $set: { "preview_data.admin_schedule_sheet": sheet,
      proposal_valuation_evaluators: [{ user: evaluator._id, column_id: `pv_${evaluator._id}`, added_by: owner._id, added_at: new Date() }] } });
    await User.deleteOne({ _id: owner._id });
    const before = await AssetReport.findById(report._id).lean();
    const workspace = await request(app).get(`/api/asset/${report._id}/proposal-valuation`).set(authHeaders(String(evaluator._id)));
    expect(workspace.status).toBe(200);
    expect(workspace.body.assetScheduleSheet.evaluator_columns.find((column: any) => column.user_id === String(owner._id))).toMatchObject({ id: "historical-owner", name: "Saved owner" });
    expect(workspace.body.assetScheduleSheet.rows[0].evaluator_values["historical-owner"]).toBe(1200);
    expect(workspace.body.permissions).toMatchObject({ canEditAll: false, evaluatorColumnId: `pv_${evaluator._id}` });
    const adminPreview = await getReportPreviewPayloadById(String(report._id));
    expect(adminPreview?.ownerColumnId).toBe("historical-owner");
    expect(adminPreview?.assetScheduleSheet?.rows[0].evaluator_values["historical-owner"]).toBe(1200);
    expect(await AssetReport.findById(report._id).lean()).toEqual(before);
    const removedOwner = await request(app).get(`/api/asset/${report._id}/proposal-valuation`).set(authHeaders(String(owner._id)));
    expect([401, 403]).toContain(removedOwner.status);
  });

  it("reconciles preview lot additions and deletions into an existing Proposal Valuation sheet", async () => {
    const owner = await createAccount({ email: "pv-lot-sync-owner@example.test" });
    const report = await createReport(owner._id);
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          "preview_data.admin_schedule_sheet.rows.0.asset_id": "old-1",
          "preview_data.admin_schedule_sheet.rows.0.asset_insight": "75000",
          "preview_data.admin_schedule_sheet.rows.0.pictures": 1,
          "preview_data.admin_schedule_sheet.rows.0.picture_urls": [
            "https://images.example/old.jpg",
          ],
        },
      }
    );
    const previewLots = [
      {
        lot_id: "lot-1",
        lot_number: "101",
        title: "Existing excavator",
        description: "Existing description",
        estimated_value: "125000",
        image_urls: [
          "https://images.example/current-1.jpg",
          "https://images.example/current-2.jpg",
        ],
      },
      {
        lot_id: "lot-new-2",
        lot_number: "2",
        title: "New preview loader",
        description: "Added after the initial PV sheet",
        estimated_value: "85000",
      },
    ];
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          lots: previewLots,
          "preview_data.lots": previewLots,
        },
      }
    );

    const withAddition = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(owner._id)));

    expect(withAddition.status).toBe(200);
    expect(withAddition.body.assetScheduleSheet.rows).toHaveLength(2);
    expect(
      withAddition.body.assetScheduleSheet.rows.map((row: any) => row.lot_id)
    ).toEqual(["lot-1", "lot-new-2"]);
    expect(
      withAddition.body.assetScheduleSheet.rows[0].evaluator_values.legacy
    ).toBe(1_000);
    expect(withAddition.body.assetScheduleSheet.rows[0]).toMatchObject({
      lot_id: "lot-1",
      asset_id: "101",
      asset_category: "Excavator",
      asset_insight: "125000",
      pictures: 2,
      picture_urls: [
        "https://images.example/current-1.jpg",
        "https://images.example/current-2.jpg",
      ],
    });
    expect(withAddition.body.assetScheduleSheet.rows[1]).toMatchObject({
      lot_id: "lot-new-2",
      asset_id: "2",
      asset_insight: "85000",
      evaluator_values: { legacy: null },
    });

    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          lots: [...previewLots].reverse(),
          "preview_data.lots": [...previewLots].reverse(),
        },
      }
    );
    const afterReorder = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(owner._id)));

    expect(afterReorder.status).toBe(200);
    expect(
      afterReorder.body.assetScheduleSheet.rows.map((row: any) => row.lot_id)
    ).toEqual(["lot-new-2", "lot-1"]);
    expect(
      afterReorder.body.assetScheduleSheet.rows[1].evaluator_values.legacy
    ).toBe(1_000);

    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          lots: [previewLots[1]],
          "preview_data.lots": [previewLots[1]],
        },
      }
    );
    const afterDeletion = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(owner._id)));

    expect(afterDeletion.status).toBe(200);
    expect(afterDeletion.body.assetScheduleSheet.rows).toHaveLength(1);
    expect(afterDeletion.body.assetScheduleSheet.rows[0].lot_id).toBe(
      "lot-new-2"
    );

    await AssetReport.updateOne(
      { _id: report._id },
      { $set: { lots: [], "preview_data.lots": [] } }
    );
    const afterDeletingEveryLot = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(owner._id)));

    expect(afterDeletingEveryLot.status).toBe(200);
    expect(afterDeletingEveryLot.body.assetScheduleSheet.rows).toEqual([]);
  });

  it("three-way merges owner review edits into PV without replacing genuine PV overrides", async () => {
    const owner = await createAccount({
      email: "pv-review-sync-owner@example.test",
    });
    const previousLot = {
      lot_id: "review-lot-1",
      lot_number: "001",
      title: "Original asset",
      description: "1975 Pontiac Trans Am",
      categories: "Emergency Vehicles",
      serial_number: "OLD-SERIAL-123",
      serial_no_or_label: "OLD-SERIAL-123",
      estimated_value: "CA$20,000",
      image_indexes: [0],
      image_urls: ["https://images.example/old.jpg"],
    };
    const previousPreviewData = {
      contract_no: "PV-REVIEW-SYNC",
      client_name: "Review sync fixture",
      lots: [previousLot],
    };
    const previousSourceSheet = buildDefaultAssetAdminScheduleSheet({
      lots: [previousLot],
      preview_data: previousPreviewData,
    } as any);
    const storedSheet = calculateAssetAdminScheduleSheet({
      evaluator_columns: [{ id: "legacy", name: "Legacy evaluator" }],
      rows: [
        {
          ...previousSourceSheet.rows[0],
          // This differs from the previous review source and is therefore a
          // genuine PV override that the three-way merge must retain.
          asset_category: "PV curated category",
          condition_score: "4",
          location: "PV-only location override",
          notes: "Keep the proposal note",
          market_check: {
            comparable_count: "High",
            avg_retail_asking_price: "Moderate",
            market_saturation: "Low",
            market_velocity: "Fast",
            regional_demand: "Strong",
            notes: "Keep the market note",
          },
          evaluator_values: { legacy: 25_000 },
          lien_search: 125,
          video_cost: 75,
        },
      ],
      file_summary: {
        buyers_premium_basis: "capped",
        total_risk_weighted_value: 21_000,
        file_risk_multiplier: 0.9,
        commission_percent_no_guarantee: 12,
        offer2_nmg_percent: 0.8,
        capped_threshold_percent: 0.12,
      },
    });
    const report = await AssetReport.create({
      user: owner._id,
      grouping_mode: "single_lot",
      imageUrls: previousLot.image_urls,
      lots: [previousLot],
      status: "preview",
      contract_no: "PV-REVIEW-SYNC",
      proposal_valuation_revision: 0,
      preview_data: {
        ...previousPreviewData,
        admin_schedule_sheet: storedSheet,
      },
    });
    const nextLot = {
      ...previousLot,
      lot_number: "002",
      title: "Corrected asset",
      description: "1980 Chevrolet Camaro",
      serial_number: "",
      serial_no_or_label: "",
      estimated_value: "CA$25,000",
      image_indexes: [0, 1],
      image_urls: [
        "https://images.example/current-1.jpg",
        "https://images.example/current-2.jpg",
      ],
    };
    const liveStream = proposalValuationStream(
      String(report._id),
      String(owner._id)
    );

    const response = await request(app)
      .put(`/api/asset/${report._id}/preview`)
      .set(authHeaders(String(owner._id)))
      .send({
        preview_data: {
          ...previousPreviewData,
          lots: [nextLot],
          admin_schedule_sheet: storedSheet,
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.files_regeneration_queued).toBe(false);
    const persisted = await AssetReport.findById(report._id).lean();
    expect((persisted as any)?.proposal_valuation_revision).toBe(1);
    expect((persisted as any)?.proposal_valuation_updated_at).toBeTruthy();
    expect(liveStream.chunks.join("")).toContain("event: pv-revision");
    expect(liveStream.chunks.join("")).toContain('"revision":1');
    liveStream.end();
    const persistedSheet = (persisted as any)?.preview_data
      ?.admin_schedule_sheet;
    expect(persistedSheet.rows[0]).toMatchObject({
      lot_id: "review-lot-1",
      asset_id: "002",
      asset_category: "PV curated category",
      year: "1980",
      make: "Chevrolet",
      model: "Camaro",
      serial_number: "",
      cr_details: "1980 Chevrolet Camaro",
      condition_score: "4",
      location: "PV-only location override",
      pictures: 2,
      picture_urls: nextLot.image_urls,
      asset_insight: "CA$25,000",
      evaluator_values: { legacy: 25_000 },
      notes: "Keep the proposal note",
      lien_search: 125,
      video_cost: 75,
    });
    expect(persistedSheet.rows[0].market_check).toMatchObject({
      comparable_count: "High",
      notes: "Keep the market note",
    });
    expect(persistedSheet.file_summary).toMatchObject({
      buyers_premium_basis: "capped",
      total_risk_weighted_value: 21_000,
      offer2_nmg_percent: 0.8,
    });

    const ownerWorkspace = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(owner._id)));
    expect(ownerWorkspace.status).toBe(200);
    expect(ownerWorkspace.body.revision).toBe(1);
    expect(ownerWorkspace.body.assetScheduleSheet.rows[0]).toMatchObject({
      year: "1980",
      make: "Chevrolet",
      model: "Camaro",
      serial_number: "",
      cr_details: "1980 Chevrolet Camaro",
      evaluator_values: { legacy: 25_000 },
    });

    const adminPreview = await getReportPreviewPayloadById(String(report._id));
    expect(adminPreview?.revision).toBe(1);
    expect(adminPreview?.assetScheduleSheet?.rows[0]).toMatchObject({
      cr_details: "1980 Chevrolet Camaro",
      evaluator_values: { legacy: 25_000 },
    });
  });

  it("lets an explicit owner review edit replace a stale legacy PV source field without erasing PV-only work", async () => {
    const owner = await createAccount({
      email: "pv-review-stale-source-owner@example.test",
    });
    const previousLot = {
      lot_id: "stale-review-lot",
      lot_number: "001",
      title: "Review source fixture",
      description: "Original review description",
      categories: "Passenger Vehicles",
      serial_number: "SOURCE-123",
      serial_no_or_label: "SOURCE-123",
      estimated_value: "CA$25,000",
      image_indexes: [],
      image_urls: [],
    };
    const previousPreviewData = {
      contract_no: "PV-STALE-REVIEW-SOURCE",
      lots: [previousLot],
    };
    const previousSourceSheet = buildDefaultAssetAdminScheduleSheet({
      lots: [previousLot],
      preview_data: previousPreviewData,
    } as any);
    const storedSheet = calculateAssetAdminScheduleSheet({
      evaluator_columns: [{ id: "legacy", name: "Legacy evaluator" }],
      rows: [
        {
          ...previousSourceSheet.rows[0],
          // Older report generations could seed a PV projection that was not
          // byte-identical to the review source. A later explicit review edit
          // must not leave that already-stale generated value behind.
          cr_details: "Legacy generated description that is already stale",
          condition_score: "3",
          location: "Regina, SK",
          market_check: {
            comparable_count: "Moderate",
            avg_retail_asking_price: "High",
            market_saturation: "Low",
            market_velocity: "Fast",
            regional_demand: "Strong",
            notes: "Retain market research",
          },
          evaluator_values: { legacy: 31_500 },
          notes: "Retain evaluator notes",
          lien_search: 140,
          video_cost: 90,
        },
      ],
      file_summary: {
        buyers_premium_basis: "capped",
        total_risk_weighted_value: 29_000,
        file_risk_multiplier: 0.87,
        commission_percent_no_guarantee: 11,
        offer2_nmg_percent: 0.81,
        capped_threshold_percent: 0.13,
      },
    });
    const report = await AssetReport.create({
      user: owner._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [previousLot],
      status: "preview",
      contract_no: "PV-STALE-REVIEW-SOURCE",
      proposal_valuation_revision: 4,
      preview_data: {
        ...previousPreviewData,
        admin_schedule_sheet: storedSheet,
      },
    });

    const correctedLot = {
      ...previousLot,
      description: "Corrected review description",
    };
    const response = await request(app)
      .put(`/api/asset/${report._id}/preview`)
      .set(authHeaders(String(owner._id)))
      .send({
        preview_data: {
          ...previousPreviewData,
          lots: [correctedLot],
          admin_schedule_sheet: storedSheet,
        },
      });

    expect(response.status).toBe(200);
    const persisted = await AssetReport.findById(report._id).lean();
    expect((persisted as any)?.proposal_valuation_revision).toBe(5);
    expect((persisted as any)?.lots?.[0]?.description).toBe(
      "Corrected review description"
    );
    expect((persisted as any)?.preview_data?.lots?.[0]?.description).toBe(
      "Corrected review description"
    );
    const persistedSheet = (persisted as any)?.preview_data
      ?.admin_schedule_sheet;
    expect(persistedSheet.rows[0]).toMatchObject({
      lot_id: "stale-review-lot",
      cr_details: "Corrected review description",
      condition_score: "3",
      location: "Regina, SK",
      evaluator_values: { legacy: 31_500 },
      notes: "Retain evaluator notes",
      cleaning: 315,
      lien_search: 140,
      video_cost: 90,
      lotting_fee: 315,
      advertising: 315,
    });
    expect(persistedSheet.rows[0].market_check).toEqual({
      comparable_count: "Moderate",
      avg_retail_asking_price: "High",
      market_saturation: "Low",
      market_velocity: "Fast",
      regional_demand: "Strong",
      notes: "Retain market research",
    });
    expect(persistedSheet.file_summary).toMatchObject({
      buyers_premium_basis: "capped",
      total_risk_weighted_value: 29_000,
      file_risk_multiplier: 0.87,
      commission_percent_no_guarantee: 11,
      offer2_nmg_percent: 0.81,
      capped_threshold_percent: 0.13,
    });

    const workspace = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(owner._id)));
    expect(workspace.status).toBe(200);
    expect(workspace.body.revision).toBe(5);
    expect(workspace.body.assetScheduleSheet.rows[0]).toMatchObject({
      cr_details: "Corrected review description",
      condition_score: "3",
      location: "Regina, SK",
      evaluator_values: { legacy: 31_500 },
      notes: "Retain evaluator notes",
      cleaning: 315,
      lien_search: 140,
      video_cost: 90,
      lotting_fee: 315,
      advertising: 315,
    });

    const adminPreview = await getReportPreviewPayloadById(String(report._id));
    expect(adminPreview?.revision).toBe(5);
    expect(adminPreview?.assetScheduleSheet?.rows[0]).toMatchObject({
      cr_details: "Corrected review description",
      evaluator_values: { legacy: 31_500 },
      notes: "Retain evaluator notes",
    });
  });

  it("derives and broadcasts a refreshed PV projection without manufacturing an unsaved sheet", async () => {
    const owner = await createAccount({
      email: "pv-review-unsaved-sheet-owner@example.test",
    });
    const previousLot = {
      lot_id: "unsaved-pv-sheet-lot",
      lot_number: "9",
      title: "Unsaved PV projection",
      description: "Original unsaved projection",
      categories: "Passenger Vehicles",
      estimated_value: "CA$18,000",
      image_indexes: [],
      image_urls: [],
    };
    const previousPreviewData = {
      contract_no: "PV-UNSAVED-SHEET",
      lots: [previousLot],
    };
    const report = await AssetReport.create({
      user: owner._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [previousLot],
      status: "preview",
      contract_no: "PV-UNSAVED-SHEET",
      proposal_valuation_revision: 2,
      preview_data: previousPreviewData,
    });
    const liveStream = proposalValuationStream(
      String(report._id),
      String(owner._id)
    );

    const response = await request(app)
      .put(`/api/asset/${report._id}/preview`)
      .set(authHeaders(String(owner._id)))
      .send({
        preview_data: {
          ...previousPreviewData,
          lots: [
            {
              ...previousLot,
              description: "Corrected before the first PV save",
            },
          ],
        },
      });

    expect(response.status).toBe(200);
    const persisted = await AssetReport.findById(report._id).lean();
    expect((persisted as any)?.proposal_valuation_revision).toBe(3);
    expect(
      (persisted as any)?.preview_data?.admin_schedule_sheet
    ).toBeUndefined();
    const workspace = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(owner._id)));
    expect(workspace.status).toBe(200);
    expect(workspace.body.revision).toBe(3);
    expect(workspace.body.assetScheduleSheet.rows[0]?.cr_details).toBe(
      "Corrected before the first PV save"
    );
    expect(liveStream.chunks.join("")).toContain("event: pv-revision");
    expect(liveStream.chunks.join("")).toContain('"revision":3');
    liveStream.end();
  });

  it("uses the same PV review merge for an assigned approver save", async () => {
    const [owner, approver] = await Promise.all([
      createAccount({ email: "pv-assigned-review-owner@example.test" }),
      createAccount({ email: "pv-assigned-review-approver@example.test" }),
    ]);
    const previousLot = {
      lot_id: "assigned-review-lot",
      lot_number: "1",
      title: "Original truck",
      description: "2011 Ram 3500",
      serial_number: "RAM-OLD",
      serial_no_or_label: "RAM-OLD",
      estimated_value: "CA$12,000",
      image_indexes: [],
      image_urls: [],
    };
    const previousPreviewData = {
      contract_no: "PV-ASSIGNED-REVIEW",
      lots: [previousLot],
    };
    const sourceSheet = buildDefaultAssetAdminScheduleSheet({
      lots: [previousLot],
      preview_data: previousPreviewData,
    } as any);
    const storedSheet = calculateAssetAdminScheduleSheet({
      evaluator_columns: [{ id: "legacy", name: "Legacy evaluator" }],
      rows: [
        {
          ...sourceSheet.rows[0],
          evaluator_values: { legacy: 12_500 },
          notes: "Approver must not erase this",
        },
      ],
      file_summary: { buyers_premium_basis: "uncapped" },
    });
    const report = await AssetReport.create({
      user: owner._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [previousLot],
      status: "pending_approval",
      approval_assigned_to: approver._id,
      contract_no: "PV-ASSIGNED-REVIEW",
      proposal_valuation_revision: 0,
      preview_data: {
        ...previousPreviewData,
        admin_schedule_sheet: storedSheet,
      },
    });
    const nextLot = {
      ...previousLot,
      description: "2012 Ford F-150 XLT",
      serial_number: "FORD-NEW",
      serial_no_or_label: "FORD-NEW",
      estimated_value: "CA$15,000",
    };

    const response = await request(app)
      .put(`/api/reports/assigned-approvals/${report._id}/preview`)
      .set(authHeaders(String(approver._id)))
      .send({
        preview_data: {
          ...previousPreviewData,
          lots: [nextLot],
          admin_schedule_sheet: storedSheet,
        },
      });

    expect(response.status).toBe(200);
    const persisted = await AssetReport.findById(report._id).lean();
    expect((persisted as any)?.proposal_valuation_revision).toBe(1);
    expect(
      (persisted as any)?.preview_data?.admin_schedule_sheet?.rows[0]
    ).toMatchObject({
      year: "2012",
      make: "Ford",
      model: "F-150 XLT",
      serial_number: "FORD-NEW",
      cr_details: "2012 Ford F-150 XLT",
      asset_insight: "CA$15,000",
      evaluator_values: { legacy: 12_500 },
      notes: "Approver must not erase this",
    });
  });

  it("does not advance or broadcast the PV revision for a review-only metadata edit", async () => {
    const owner = await createAccount({
      email: "pv-review-metadata-owner@example.test",
    });
    const lot = {
      lot_id: "metadata-lot",
      lot_number: "1",
      title: "Metadata fixture",
      description: "2020 Ford F-150",
      serial_number: "META-123",
      serial_no_or_label: "META-123",
      estimated_value: "CA$30,000",
      image_indexes: [],
      image_urls: [],
    };
    const previousPreviewData = {
      contract_no: "PV-METADATA",
      client_name: "Before metadata edit",
      lots: [lot],
    };
    const sheet = buildDefaultAssetAdminScheduleSheet({
      lots: [lot],
      preview_data: previousPreviewData,
    } as any);
    const report = await AssetReport.create({
      user: owner._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [lot],
      status: "preview",
      contract_no: "PV-METADATA",
      proposal_valuation_revision: 0,
      preview_data: {
        ...previousPreviewData,
        admin_schedule_sheet: sheet,
      },
    });
    const liveStream = proposalValuationStream(
      String(report._id),
      String(owner._id)
    );

    const response = await request(app)
      .put(`/api/asset/${report._id}/preview`)
      .set(authHeaders(String(owner._id)))
      .send({
        preview_data: {
          ...previousPreviewData,
          client_name: "After metadata edit",
          admin_schedule_sheet: sheet,
        },
      });

    expect(response.status).toBe(200);
    const persisted = await AssetReport.findById(report._id).lean();
    expect((persisted as any)?.proposal_valuation_revision).toBe(0);
    expect(
      (persisted as any)?.preview_data?.admin_schedule_sheet?.rows[0]
        ?.cr_details
    ).toBe("2020 Ford F-150");
    expect(liveStream.chunks.join("")).not.toContain("event: pv-revision");
    liveStream.end();
  });

  it("scopes safe workspaces and edits to the owner and assigned evaluator", async () => {
    const [owner, evaluator, unassigned] = await Promise.all([
      createAccount({ email: "pv-owner@example.test" }),
      createAccount({ email: "pv-evaluator@example.test" }),
      createAccount({ email: "pv-unassigned@example.test" }),
    ]);
    const report = await createReport(owner._id);

    const assignment = await request(app)
      .put(`/api/asset/${report._id}/proposal-valuation/evaluators`)
      .set(authHeaders(String(owner._id)))
      .send({
        evaluatorUserIds: [String(evaluator._id)],
        baseRevision: 0,
        clientMutationId: "assign-evaluator-1",
      });
    expect(assignment.status).toBe(200);
    expect(assignment.body.revision).toBe(1);
    expect(assignment.body.permissions).toMatchObject({
      canManageEvaluators: true,
      canEditAll: true,
      canRegenerateFiles: true,
    });
    const linkedColumn = assignment.body.assetScheduleSheet.evaluator_columns.find(
      (column: any) => column.user_id === String(evaluator._id)
    );
    expect(linkedColumn).toMatchObject({
      user_id: String(evaluator._id),
      name: evaluator.username,
      email: evaluator.email,
    });
    expect(
      assignment.body.assetScheduleSheet.evaluator_columns.find(
        (column: any) => column.id === "legacy"
      )
    ).toMatchObject({ name: "Legacy evaluator" });

    const evaluatorWorkspace = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(evaluator._id)));
    expect(evaluatorWorkspace.status).toBe(200);
    expect(evaluatorWorkspace.body.permissions).toEqual({
      canManageEvaluators: false,
      canEditAll: false,
      evaluatorColumnId: linkedColumn.id,
      canRegenerateFiles: false,
    });
    expect(evaluatorWorkspace.body).not.toHaveProperty("data");
    expect(JSON.stringify(evaluatorWorkspace.body)).not.toContain(
      "private.docx"
    );

    const unassignedWorkspace = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(unassigned._id)));
    expect(unassignedWorkspace.status).toBe(404);

    const assignedList = await request(app)
      .get("/api/asset/proposal-valuations")
      .set(authHeaders(String(evaluator._id)));
    expect(assignedList.status).toBe(200);
    expect(assignedList.body.items).toEqual([
      expect.objectContaining({
        reportId: String(report._id),
        role: "evaluator",
        revision: 1,
        participantCount: 2,
      }),
    ]);
    expect(JSON.stringify(assignedList.body)).not.toContain("preview_files");
    expect(JSON.stringify(assignedList.body)).not.toContain("https://");

    const evaluatorEdit = await request(app)
      .patch(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(evaluator._id)))
      .send({
        baseRevision: 1,
        clientMutationId: "evaluator-edit-1",
        changes: [
          {
            lotId: "lot-1",
            field: `evaluator_values.${linkedColumn.id}`,
            value: 1_500,
          },
        ],
      });
    expect(evaluatorEdit.status).toBe(200);
    expect(evaluatorEdit.body.revision).toBe(2);
    expect(
      evaluatorEdit.body.assetScheduleSheet.rows[0].evaluator_values[
        linkedColumn.id
      ]
    ).toBe(1_500);

    const forbiddenEdit = await request(app)
      .patch(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(evaluator._id)))
      .send({
        baseRevision: 2,
        clientMutationId: "evaluator-forbidden-1",
        changes: [{ lotId: "lot-1", field: "notes", value: "no" }],
      });
    expect(forbiddenEdit.status).toBe(403);
    expect(forbiddenEdit.body.code).toBe(
      "PROPOSAL_VALUATION_FIELD_FORBIDDEN"
    );

    const staleEdit = await request(app)
      .patch(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(evaluator._id)))
      .send({
        baseRevision: 1,
        clientMutationId: "evaluator-stale-1",
        changes: [
          {
            lotId: "lot-1",
            field: `evaluator_values.${linkedColumn.id}`,
            value: 1_700,
          },
        ],
      });
    expect(staleEdit.status).toBe(409);
    expect(staleEdit.body).toMatchObject({
      code: "PV_REVISION_CONFLICT",
      currentRevision: 2,
    });

    const idempotentRetry = await request(app)
      .patch(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(evaluator._id)))
      .send({
        baseRevision: 1,
        clientMutationId: "evaluator-edit-1",
        changes: [
          {
            lotId: "lot-1",
            field: `evaluator_values.${linkedColumn.id}`,
            value: 1_500,
          },
        ],
      });
    expect(idempotentRetry.status).toBe(200);
    expect(idempotentRetry.body).toMatchObject({
      revision: 2,
      idempotent: true,
    });

    const removal = await request(app)
      .put(`/api/asset/${report._id}/proposal-valuation/evaluators`)
      .set(authHeaders(String(owner._id)))
      .send({
        evaluatorUserIds: [],
        baseRevision: 2,
        clientMutationId: "remove-evaluator-1",
      });
    expect(removal.status).toBe(200);
    expect(removal.body.revision).toBe(3);
    expect(removal.body.assetScheduleSheet.evaluator_columns.filter((column: any) => column.user_id))
      .toEqual([expect.objectContaining({ user_id: String(owner._id), id: `pv_${owner._id}` })]);
    const removedWorkspace = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(evaluator._id)));
    expect(removedWorkspace.status).toBe(404);
  });

  it("validates candidate capability and the four-evaluator limit", async () => {
    const owner = await createAccount({ email: "limit-owner@example.test" });
    const report = await createReport(owner._id);
    const eligible = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createAccount({ email: `eligible-${index}@example.test` })
      )
    );
    const disabled = await createAccount({
      email: "disabled-evaluator@example.test",
      enabled: false,
    });

    const tooMany = await request(app)
      .put(`/api/asset/${report._id}/proposal-valuation/evaluators`)
      .set(authHeaders(String(owner._id)))
      .send({
        evaluatorUserIds: eligible.map((user) => String(user._id)),
        baseRevision: 0,
        clientMutationId: "too-many-evaluators",
      });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe(
      "PROPOSAL_VALUATION_EVALUATOR_LIMIT"
    );

    const unavailable = await request(app)
      .put(`/api/asset/${report._id}/proposal-valuation/evaluators`)
      .set(authHeaders(String(owner._id)))
      .send({
        evaluatorUserIds: [String(disabled._id)],
        baseRevision: 0,
        clientMutationId: "disabled-evaluator",
      });
    expect(unavailable.status).toBe(400);
    expect(unavailable.body.code).toBe(
      "PROPOSAL_VALUATION_EVALUATOR_INVALID"
    );

    await User.updateOne(
      { _id: owner._id },
      { $set: { proposalValuationEnabled: false } }
    );
    const disabledOwner = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(owner._id)));
    expect(disabledOwner.status).toBe(403);
    expect(disabledOwner.body.code).toBe("PROPOSAL_VALUATION_DISABLED");

    await User.updateOne(
      { _id: owner._id },
      {
        $set: {
          proposalValuationEnabled: true,
          isVerified: false,
        },
      }
    );
    const unverifiedOwner = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(owner._id)));
    expect(unverifiedOwner.status).toBe(403);
    expect(unverifiedOwner.body.code).toBe("PROPOSAL_VALUATION_DISABLED");

    await User.updateOne(
      { _id: owner._id },
      { $set: { isVerified: true, role: "admin" } }
    );
    const wrongRoleOwner = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(owner._id), "admin"));
    expect(wrongRoleOwner.status).toBe(403);
    expect(wrongRoleOwner.body.code).toBe("PROPOSAL_VALUATION_DISABLED");
  });

  it("returns a distinct transient response while canonical artifacts publish", async () => {
    const owner = await createAccount({ email: "publish-lock-owner@example.test" });
    const report = await createReport(owner._id);
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          proposal_valuation_artifact_publish_token: "active-publisher",
          proposal_valuation_artifact_publish_revision: 0,
          proposal_valuation_artifact_publish_expires_at: new Date(
            Date.now() + 30_000
          ),
        },
      }
    );

    const response = await request(app)
      .patch(`/api/asset/${report._id}/proposal-valuation`)
      .set(authHeaders(String(owner._id)))
      .send({
        baseRevision: 0,
        clientMutationId: "save-during-publication",
        changes: [{ lotId: "lot-1", field: "notes", value: "retry me" }],
      });

    expect(response.status).toBe(423);
    expect(response.body).toMatchObject({
      code: "PV_ARTIFACT_PUBLISH_IN_PROGRESS",
      currentRevision: 0,
      retryAfterMs: 750,
    });
  });

  it("preserves structured preview-write conflicts at the generic Asset HTTP boundary", async () => {
    const owner = await createAccount({
      email: "preview-conflict-owner@example.test",
    });
    const report = await createReport(owner._id);
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          proposal_valuation_artifact_publish_token: "active-preview-publisher",
          proposal_valuation_artifact_publish_revision: 0,
          proposal_valuation_artifact_publish_expires_at: new Date(
            Date.now() + 30_000
          ),
        },
      }
    );
    const latest = await AssetReport.findById(report._id).lean();

    const response = await request(app)
      .put(`/api/asset/${report._id}/preview`)
      .set(authHeaders(String(owner._id)))
      .send({
        preview_data: {
          ...((latest as any)?.preview_data || {}),
          client_name: "Concurrent generic edit",
        },
      });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: "PV_PREVIEW_WRITE_CONFLICT",
      message:
        "The report changed while preview data was being saved. Refresh and retry.",
    });
  });

  it("does not report a duplicate regeneration mutation as queued before queue state is durable", async () => {
    const owner = await createAccount({ email: "regen-owner@example.test" });
    const report = await createReport(owner._id);
    const input = {
      reportId: String(report._id),
      user: owner,
      baseRevision: 0,
      clientMutationId: "regenerate-once",
    };

    await expect(
      getProposalValuationRegenerationContext(input)
    ).resolves.toMatchObject({ idempotent: false, revision: 0 });
    await expect(
      getProposalValuationRegenerationContext(input)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PV_REGENERATION_CLAIM_IN_PROGRESS",
      details: { retryAfterMs: 500 },
    });

    await AssetReport.updateOne(
      { _id: report._id },
      { $set: { files_generating: true, job_status: "queued" } }
    );
    await expect(
      getProposalValuationRegenerationContext(input)
    ).resolves.toMatchObject({ idempotent: true, revision: 0 });
  });

  it("returns report-scoped safe evaluator options to owners and admins", async () => {
    const [owner, eligible, disabled, admin] = await Promise.all([
      createAccount({ email: "options-owner@example.test" }),
      createAccount({ email: "options-eligible@example.test" }),
      createAccount({
        email: "options-disabled@example.test",
        enabled: false,
      }),
      createAccount({
        email: "options-admin@example.test",
        role: "superadmin",
        enabled: false,
      }),
    ]);
    const report = await createReport(owner._id);

    const ownerOptions = await request(app)
      .get(
        `/api/asset/${report._id}/proposal-valuation/evaluator-options?q=eligible`
      )
      .set(authHeaders(String(owner._id)));
    expect(ownerOptions.status).toBe(200);
    expect(ownerOptions.body.items).toEqual([
      {
        id: String(eligible._id),
        username: eligible.username,
        companyName: eligible.companyName,
        email: eligible.email,
        avatarUrl: "",
      },
    ]);
    expect(JSON.stringify(ownerOptions.body)).not.toContain(disabled.email);

    const adminOptions = await request(app)
      .get(
        `/api/admin/reports/${report._id}/proposal-valuation/evaluator-options?q=eligible`
      )
      .set(authHeaders(String(admin._id), "superadmin"));
    expect(adminOptions.status).toBe(200);
    expect(adminOptions.body).toEqual(ownerOptions.body);
  });

  it("atomically synchronizes linked admin columns with durable evaluator access", async () => {
    const [owner, evaluator, admin] = await Promise.all([
      createAccount({ email: "admin-sync-owner@example.test" }),
      createAccount({ email: "admin-sync-evaluator@example.test" }),
      createAccount({
        email: "admin-sync-admin@example.test",
        role: "superadmin",
        enabled: false,
      }),
    ]);
    const report = await createReport(owner._id);
    const submitted = initialSheet();
    submitted.evaluator_columns.push({
      id: `pv_${evaluator._id}`,
      name: "Client-controlled name",
      user_id: String(evaluator._id),
      email: "spoofed@example.test",
      avatar_url: "https://spoofed.example/avatar.png",
    });

    const result = await saveAdminProposalValuationSheet({
      reportId: String(report._id),
      adminUserId: String(admin._id),
      rawSheet: submitted,
      baseRevision: 0,
    });

    expect(result.revision).toBe(1);
    expect(result.assetScheduleSheet.evaluator_columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "legacy", name: "Legacy evaluator" }),
        expect.objectContaining({
          id: `pv_${evaluator._id}`,
          user_id: String(evaluator._id),
          name: evaluator.username,
          email: evaluator.email,
        }),
      ])
    );
    const stored = await AssetReport.findById(report._id).lean();
    expect((stored as any)?.proposal_valuation_revision).toBe(1);
    expect((stored as any)?.proposal_valuation_evaluators).toHaveLength(1);
    expect(
      String((stored as any)?.proposal_valuation_evaluators[0].user)
    ).toBe(String(evaluator._id));
    expect(
      String((stored as any)?.proposal_valuation_updated_by)
    ).toBe(String(admin._id));

    const unpopulatedCanonical = getCanonicalProposalValuationSheet(stored);
    expect(
      unpopulatedCanonical.evaluator_columns.find(
        (column) => column.user_id === String(evaluator._id)
      )
    ).toMatchObject({
      name: evaluator.username,
      email: evaluator.email,
    });

    const directPreview = await getReportPreviewPayloadById(String(report._id));
    expect(
      directPreview?.assetScheduleSheet?.evaluator_columns.find(
        (column) => column.user_id === String(evaluator._id)
      )
    ).toMatchObject({
      name: evaluator.username,
      email: evaluator.email,
    });

    const pdfReport = await PdfReport.create({
      filename: "pv-fixture.pdf",
      address: "Proposal Valuation Fixture",
      fairMarketValue: "CAD 1,000",
      user: owner._id,
      reportType: "Asset",
      reportModel: "AssetReport",
      report: report._id,
      approvalStatus: "approved",
    });
    const pdfResolvedPreview = await getReportPreviewPayloadById(
      String(pdfReport._id)
    );
    expect(
      pdfResolvedPreview?.assetScheduleSheet?.evaluator_columns.find(
        (column) => column.user_id === String(evaluator._id)
      )
    ).toMatchObject({
      name: evaluator.username,
      email: evaluator.email,
    });

    await expect(
      saveAdminProposalValuationSheet({
        reportId: String(report._id),
        adminUserId: String(admin._id),
        rawSheet: submitted,
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PV_REVISION_CONFLICT",
      details: { currentRevision: 1 },
    });
  });

  it("exports the canonical workbook only through existing PV viewer and admin access gates", async () => {
    const [owner, evaluator, outsider, regularAdmin, superadmin] =
      await Promise.all([
        createAccount({ email: "excel-owner@example.test" }),
        createAccount({ email: "excel-evaluator@example.test" }),
        createAccount({ email: "excel-outsider@example.test" }),
        createAccount({
          email: "excel-admin@example.test",
          role: "admin",
          enabled: false,
        }),
        createAccount({
          email: "excel-superadmin@example.test",
          role: "superadmin",
          enabled: false,
        }),
      ]);
    const report = await createReport(owner._id);
    const assignment = await request(app)
      .put(`/api/asset/${report._id}/proposal-valuation/evaluators`)
      .set(authHeaders(String(owner._id)))
      .send({
        evaluatorUserIds: [String(evaluator._id)],
        baseRevision: 0,
        clientMutationId: "assign-excel-evaluator",
      });
    expect(assignment.status).toBe(200);

    const anonymous = await request(app).get(
      `/api/asset/${report._id}/proposal-valuation/export`
    );
    expect(anonymous.status).toBe(401);

    const outsiderResponse = await request(app)
      .get(`/api/asset/${report._id}/proposal-valuation/export`)
      .set(authHeaders(String(outsider._id)));
    expect(outsiderResponse.status).toBe(404);
    expect(outsiderResponse.body.code).toBe("PROPOSAL_VALUATION_NOT_FOUND");

    for (const viewer of [owner, evaluator]) {
      const response = await request(app)
        .get(`/api/asset/${report._id}/proposal-valuation/export`)
        .set(authHeaders(String(viewer._id)))
        .buffer(true)
        .parse(binaryParser);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      expect(response.headers["content-disposition"]).toContain(
        'filename="proposal-valuation-PV-001.xlsx"'
      );
      expect(response.headers["cache-control"]).toContain("no-store");
      expect(response.headers["access-control-expose-headers"]).toBe(
        "Content-Disposition"
      );
      expect(Buffer.isBuffer(response.body)).toBe(true);
      expect((response.body as Buffer).subarray(0, 2).toString("utf8")).toBe(
        "PK"
      );
    }

    const pdfAlias = await PdfReport.create({
      filename: "pv-excel-fixture.pdf",
      address: "Proposal Valuation Excel Fixture",
      fairMarketValue: "CAD 1,000",
      user: owner._id,
      reportType: "Asset",
      reportModel: "AssetReport",
      report: report._id,
      approvalStatus: "approved",
    });
    const adminResponse = await request(app)
      .get(`/api/admin/reports/${pdfAlias._id}/proposal-valuation/export`)
      .set(authHeaders(String(regularAdmin._id), "admin"));
    expect(adminResponse.status).toBe(200);
    expect(adminResponse.headers["content-disposition"]).toContain(
      "proposal-valuation-PV-001.xlsx"
    );

    await AssetReport.updateOne(
      { _id: report._id },
      { $set: { status: "processing" } }
    );
    const restrictedAdmin = await request(app)
      .get(`/api/admin/reports/${report._id}/proposal-valuation/export`)
      .set(authHeaders(String(regularAdmin._id), "admin"));
    expect(restrictedAdmin.status).toBe(403);
    expect(restrictedAdmin.body.message).toBe(
      "Superadmin privileges required"
    );

    const unrestrictedSuperadmin = await request(app)
      .get(`/api/admin/reports/${report._id}/proposal-valuation/export`)
      .set(authHeaders(String(superadmin._id), "superadmin"));
    expect(unrestrictedSuperadmin.status).toBe(200);
  });
});
