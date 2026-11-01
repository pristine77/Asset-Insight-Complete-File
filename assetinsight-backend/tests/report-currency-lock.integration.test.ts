import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import ReportDraft from "../src/models/reportDraft.model.js";
import User from "../src/models/user.model.js";
import { persistAssetPreviewDataPreservingProposalValuation, saveAssetReportWithProtectedPreviewData } from "../src/service/assetPreviewDataPersistenceService.js";
import { buildLotListingPreviewPersistence } from "../src/utils/lotListingPreviewPersistence.js";

const queues = vi.hoisted(() => ({ asset: vi.fn(), lot: vi.fn(), createLot: vi.fn() }));
vi.mock("../src/jobs/assetReportJob.js", async (original) => ({
  ...(await original<typeof import("../src/jobs/assetReportJob.js")>()),
  queuePreviewFilesJob: queues.asset,
}));
vi.mock("../src/jobs/lotListingJob.js", () => ({
  regenerateLotListingFiles: queues.lot, queueLotListingJob: queues.createLot,
}));

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
const originalDeviceApproval = process.env.DEVICE_APPROVAL_ENFORCEMENT;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const receipt = { token: "pending-old-client-conversion", quote: { fromCurrency: "CAD", toCurrency: "USD", rate: 0.5 }, basis: {} };
const sheet = { evaluator_columns: [{ id: "manual", name: "Evaluator" }], rows: [{ lot_id: "lot-1", evaluator_values: { manual: 1200 } }], file_summary: {} };

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  for (const mock of Object.values(queues)) mock.mockReset();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  if (originalDeviceApproval === undefined) delete process.env.DEVICE_APPROVAL_ENFORCEMENT;
  else process.env.DEVICE_APPROVAL_ENFORCEMENT = originalDeviceApproval;
});

async function user() {
  const id = new mongoose.Types.ObjectId();
  return User.create({ email: `currency-${id}@example.test`, username: `currency-${id}`, password: "Password123!", authProvider: "email", isVerified: true, role: "admin" });
}
const auth = (id: unknown) => ({ Authorization: `Bearer ${jwt.sign({ id: String(id), role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "30m" })}` });
type Kind = "asset" | "lot-listing";
async function fixture(kind: Kind, status = "preview", legacy = false, historical = false) {
  const owner = await user(), approver = await user();
  const currency = legacy ? "USD" : "CAD";
  const lots = [{ lot_id: "lot-1", lot_number: "1", title: "Saved title", estimated_value: `${currency} 1000`, image_urls: [], condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" } }];
  const preview = { contract_no: "SYNTHETIC-CURRENCY", sales_date: "2026-10-31T00:00:00.000Z", location: "Regina, SK", ...(legacy ? {} : { currency }), total_value: 1000, lots, valuation_methods: ["FML"], admin_schedule_sheet: sheet, ...(historical ? { currency_conversion: receipt } : {}) };
  const Model: any = kind === "asset" ? AssetReport : LotListing;
  const report = await Model.create({ user: owner._id, approval_assigned_to: approver._id, grouping_mode: "single_lot", imageUrls: [], videoUrls: [], contract_no: preview.contract_no, sales_date: new Date(preview.sales_date), location: preview.location, currency, total_value: 1000, total_appraised_value: 1000, lots, valuation_methods: ["FML"], status, job_status: "done", proposal_valuation_revision: 7, preview_data: preview });
  return { owner, approver, report, Model, preview: clone((await Model.findById(report._id).lean()).preview_data) as typeof preview };
}

const workflows = ["owner-save", "owner-submit", "owner-resubmit", "approver-save", "approver-resubmit"] as const;
for (const kind of ["asset", "lot-listing"] as const) {
  describe(`${kind} saved currency compatibility`, () => {
    it.each(workflows)("rejects a pending old conversion in %s before any report or job write", async (workflow) => {
      const status = workflow === "owner-resubmit" || workflow.startsWith("approver") ? "pending_approval" : "preview";
      const f = await fixture(kind, status);
      const before = clone(await f.Model.findById(f.report._id).lean());
      const next = { ...clone(f.preview), currency: "USD", total_value: 500, currency_conversion: receipt, _currency_base_revision: "old-read-revision" };
      next.lots[0].estimated_value = "USD 500";
      next.lots[0].title = "Must not be persisted";
      const approver = workflow.startsWith("approver");
      const path = approver ? `/api/reports/assigned-approvals/${f.report._id}/preview${workflow.endsWith("resubmit") ? "/resubmit" : ""}` : `/api/${kind}/${f.report._id}/${workflow === "owner-save" ? "preview" : workflow === "owner-submit" ? "submit-approval" : "resubmit"}`;
      const response = await (workflow.endsWith("save") ? request(app).put(path) : request(app).post(path)).set(auth(approver ? f.approver._id : f.owner._id)).send({ preview_data: next });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body).toMatchObject({ code: "REPORT_CURRENCY_LOCKED" });
      expect(response.body.message).toMatch(/Reload the preview.*CAD/);
      expect(clone(await f.Model.findById(f.report._id).lean())).toEqual(before);
      expect(await ReportJob.countDocuments()).toBe(0);
      for (const queue of Object.values(queues)) expect(queue).not.toHaveBeenCalled();
    });

    it.each(["different-currency", "invalid-currency", "same-label-new-receipt"])("rejects %s before normalization can erase proof", async (failure) => {
      const f = await fixture(kind);
      const before = clone(await f.Model.findById(f.report._id).lean());
      const next: any = { ...clone(f.preview), total_value: 500 };
      if (failure === "different-currency") next.currency = "USD";
      if (failure === "invalid-currency") next.currency = "US dollars";
      if (failure === "same-label-new-receipt") next.currency_conversion = receipt;
      const response = await request(app).put(`/api/${kind}/${f.report._id}/preview`).set(auth(f.owner._id)).send({ preview_data: next });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.code).toBe("REPORT_CURRENCY_LOCKED");
      expect(clone(await f.Model.findById(f.report._id).lean())).toEqual(before);
    });

    it.each([false, true])("preserves a legacy-root/same-currency zero edit (historical receipt=%s)", async (historical) => {
      const f = await fixture(kind, "preview", !historical, historical);
      const next: any = { ...clone(f.preview), total_value: 0, _currency_base_revision: "ordinary-old-client-read-marker" };
      if (historical) next.currency = " cad ";
      next.lots[0].estimated_value = `${historical ? "CAD" : "USD"} 0`;
      next.lots[0].title = "Manual zero edit";
      const response = await request(app).put(`/api/${kind}/${f.report._id}/preview`).set(auth(f.owner._id)).send({ preview_data: next });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const saved: any = await f.Model.findById(f.report._id).lean();
      expect(saved.currency).toBe(historical ? "CAD" : "USD");
      expect(saved.preview_data.currency).toBe(saved.currency);
      expect(saved.total_value).toBe(0);
      expect(saved.lots[0].estimated_value).toBe(next.lots[0].estimated_value);
      expect(saved.preview_data.lots[0].title).toBe("Manual zero edit");
      expect(saved.preview_data.currency_conversion).toBeUndefined();
      expect(saved.preview_data._currency_base_revision).toBeUndefined();
      if (kind === "asset") expect(saved.preview_data.admin_schedule_sheet.rows[0].evaluator_values).toEqual({ manual: 1200 });
      for (const queue of Object.values(queues)) expect(queue).not.toHaveBeenCalled();
    });
  });
}

it.each(["asset", "lot-listing"] as const)("rejects a stale converted %s draft submission before making its hidden report visible", async (kind) => {
  const f = await fixture(kind);
  const draft = await ReportDraft.create({ user: f.owner._id, clientDraftId: `draft-${f.report._id}`, type: kind === "asset" ? "asset" : "lotListing", revision: 3, previewStatus: "ready", previewReportId: f.report._id, previewProcessedRevision: 3 });
  await f.Model.updateOne({ _id: f.report._id }, { $set: { source_draft_id: draft._id, source_draft_revision: 3, is_draft_preview: true } });
  const beforeReport = clone(await f.Model.findById(f.report._id).lean());
  const beforeDraft = clone(await ReportDraft.findById(draft._id).lean());
  const next = { ...clone(f.preview), currency: "USD", total_value: 500, currency_conversion: receipt };
  const response = await request(app).post(`/api/report-drafts/${draft._id}/promote-preview`).set(auth(f.owner._id)).send({ submit: true, preview_data: next });
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.code).toBe("REPORT_CURRENCY_LOCKED");
  expect(clone(await f.Model.findById(f.report._id).lean())).toEqual(beforeReport);
  expect(clone(await ReportDraft.findById(draft._id).lean())).toEqual(beforeDraft);
  expect(await ReportJob.countDocuments()).toBe(0);
});

it("rejects the Lot Listing legacy root details payload without any persistence", async () => {
  const f = await fixture("lot-listing", "preview", true);
  const before = clone(await f.Model.findById(f.report._id).lean());
  const response = await request(app).put(`/api/lot-listing/${f.report._id}/preview`).set(auth(f.owner._id)).send({ details: { currency: "CAD", total_value: 1 }, lots: [{ ...f.preview.lots[0], estimated_value: "CAD 1" }] });
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(clone(await f.Model.findById(f.report._id).lean())).toEqual(before);
});

it("rechecks both raw persistence helpers and the Asset dotted-write helper", async () => {
  const f = await fixture("asset");
  const before = clone(await AssetReport.findById(f.report._id).lean());
  const next = { ...clone(f.preview), currency: "USD", total_value: 500, currency_conversion: receipt };
  const report: any = await AssetReport.findById(f.report._id);
  report.preview_data = next;
  await expect(saveAssetReportWithProtectedPreviewData({ report, previousPreviewData: f.preview })).rejects.toMatchObject({ code: "REPORT_CURRENCY_LOCKED", statusCode: 409 });
  await expect(persistAssetPreviewDataPreservingProposalValuation({ reportId: String(report._id), previewData: next, previousPreviewData: f.preview })).rejects.toMatchObject({ code: "REPORT_CURRENCY_LOCKED", statusCode: 409 });
  expect(() => buildLotListingPreviewPersistence(next, { currency: "CAD", preview_data: f.preview })).toThrow(/Reload the preview/);
  expect(clone(await AssetReport.findById(f.report._id).lean())).toEqual(before);
});
