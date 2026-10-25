import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AssetReport from "../src/models/asset.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import User from "../src/models/user.model.js";
import { assetPreviewFingerprint } from "../src/utils/assetGenerationIdentity.js";
import { buildAuctioneerSpecRows, normalizePreviewDataAuctioneerSpecs } from "../src/utils/auctioneerSpecRows.js";

// This suite exercises real HTTP/auth/database acceptance only. The generation
// outbox is inspected; no worker, provider, file builder or storage call runs.
const effects = vi.hoisted(() => ({ queue: vi.fn(), analyze: vi.fn(), email: vi.fn(), notify: vi.fn() }));
vi.mock("../src/jobs/assetReportJob.js", async (original) => ({
  ...await original<typeof import("../src/jobs/assetReportJob.js")>(),
  queuePreviewFilesJob: effects.queue, queueAssetPreviewJob: effects.analyze,
}));
vi.mock("../src/utils/sendVerificationEmail.js", async (original) => ({
  ...await original<typeof import("../src/utils/sendVerificationEmail.js")>(), sendEmail: effects.email, sendTransactionalEmail: effects.email,
}));
vi.mock("../src/service/notificationService.js", async (original) => ({
  ...await original<typeof import("../src/service/notificationService.js")>(), notifyUser: effects.notify,
}));

type Workflow = "owner-submit" | "owner-resubmit" | "assigned-approver";
type Selections = { condition?: string; completeness?: string; legal?: string };
let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let owner: any, approver: any;
const deviceByUser = new Map<string, { id: string; key: string }>();
const oldQueue = process.env.REPORT_QUEUE_BACKEND;
const headers = (actor: any) => {
  const device = deviceByUser.get(String(actor._id))!;
  return { Authorization: `Bearer ${jwt.sign({ id: String(actor._id), role: "user", did: device.id, dv: 0 }, process.env.JWT_SECRET!, { expiresIn: "30m" })}`,
    "X-Device-Key": device.key };
};
const previewPath = (id: unknown, workflow: Workflow) => workflow === "assigned-approver"
  ? `/api/reports/assigned-approvals/${id}/preview` : `/api/asset/${id}/preview`;
const actorFor = (workflow: Workflow) => workflow === "assigned-approver" ? approver : owner;

function applySelections(preview: any, numbers: Set<string>, selections: Selections) {
  return { ...preview, lots: preview.lots.map((lot: any) => numbers.has(lot.lot_number)
    ? { ...lot, condition_report_selections: { ...lot.condition_report_selections, ...selections } } : lot) };
}

function makePreview() {
  const lots = Array.from({ length: 100 }, (_, index) => ({
    lot_id: `stable-lot-${index + 1}`, lot_number: String(index + 1), title: `Reviewed vehicle ${index + 1}`,
    description: `Independent description for lot ${index + 1}.\nKeep the second paragraph and https://example.test/reference/${index + 1}.`,
    estimated_value: `CAD ${1000 + index}`, categories: "Sport Utility Vehicle", serial_number: `SAVED-SERIAL-${index + 1}`,
    image_urls: [`https://assetinsight.test/bulk-conditions/${index + 1}-first.jpg`, `https://assetinsight.test/bulk-conditions/${index + 1}-last.jpg`],
    image_indexes: [index * 2, index * 2 + 1],
    condition_report_selections: index === 99 ? {} : {
      condition: "Unverified Running Condition", completeness: "Has Keys", legal: "No Title",
    },
    condition_report_specs: { "Serial Number": `SAVED-SERIAL-${index + 1}`, "Running Condition": "Unverified Running Condition", "Ownership Type": "No Title" },
  }));
  return normalizePreviewDataAuctioneerSpecs({ contract_no: "BULK-CONDITIONS-100", currency: "CAD", location: "Regina, SK",
    include_damage_analysis: false, cover_image_urls: [lots[42].image_urls[1], lots[3].image_urls[0]], lots });
}

async function fixture(workflow: Workflow) {
  const preview = makePreview();
  return AssetReport.create({ user: owner._id, contract_no: preview.contract_no, grouping_mode: "single_lot", currency: "CAD",
    imageUrls: preview.lots.flatMap((lot) => lot.image_urls), lots: preview.lots, preview_data: preview,
    status: workflow === "owner-submit" ? "preview" : workflow === "assigned-approver" ? "pending_approval" : "error",
    job_status: workflow === "owner-resubmit" ? "error" : "done", job_id: "previous-generation", files_generating: false, files_regenerating: false,
    ...(workflow !== "owner-submit" ? { preview_submitted_at: new Date("2026-09-01") } : {}),
    ...(workflow === "owner-resubmit" ? { job_error: "Fixture failed file generation" } : {}),
    ...(workflow === "assigned-approver" ? { approval_assigned_to: approver._id, approval_requested_at: new Date("2026-09-01") } : {}),
  });
}

async function read(id: unknown, workflow: Workflow) {
  const response = await request(app).get(previewPath(id, workflow)).set(headers(actorFor(workflow)));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.preview_data;
}
async function saveAndRead(id: unknown, workflow: Workflow, preview: any) {
  const response = await request(app).put(previewPath(id, workflow)).set(headers(actorFor(workflow))).send({ preview_data: preview });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(effects.queue).not.toHaveBeenCalled();
  return read(id, workflow);
}
function expectUnchangedReportData(actual: any, original: any) {
  expect(actual.lots).toHaveLength(100);
  for (let index = 0; index < 100; index++) {
    for (const field of ["lot_id", "lot_number", "title", "description", "estimated_value", "serial_number", "image_urls", "image_indexes"]) {
      expect(actual.lots[index][field], `lot ${index + 1}: ${field}`).toEqual(original.lots[index][field]);
    }
  }
  expect(actual.cover_image_urls).toEqual(original.cover_image_urls);
}

beforeAll(async () => {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  const create = (name: string) => User.create({ username: name, email: `${name}@example.test`, password: "Password123!", authProvider: "email", isVerified: true, role: "user" });
  [owner, approver] = await Promise.all([create("bulk-owner"), create("bulk-approver")]);
  const { default: DeviceRegistration } = await import("../src/models/deviceRegistration.model.js");
  for (const actor of [owner, approver]) {
    const key = `isolated-bulk-device-${actor._id}`;
    const device = await DeviceRegistration.create({ user: actor._id, installationKeyHash: createHash("sha256").update(key).digest("hex"),
      platform: "web", formFactor: "desktop", displayName: "Isolated approved bulk-condition test device", status: "approved", sessionVersion: 0 });
    deviceByUser.set(String(actor._id), { id: String(device._id), key });
  }
});
beforeEach(async () => {
  effects.queue.mockReset().mockRejectedValue(new Error("Isolated file dispatch unavailable; durable intent retained"));
  effects.analyze.mockReset().mockRejectedValue(new Error("Unexpected analysis call"));
  effects.email.mockReset().mockResolvedValue(undefined);
  effects.notify.mockReset().mockResolvedValue(undefined);
  await Promise.all([AssetReport.deleteMany({}), ReportJob.deleteMany({})]);
});
afterAll(async () => {
  await mongoose.disconnect(); await mongo.stop();
  if (oldQueue === undefined) delete process.env.REPORT_QUEUE_BACKEND; else process.env.REPORT_QUEUE_BACKEND = oldQueue;
});

describe.sequential("Asset bulk condition whole-preview persistence", () => {
  it.each(["owner-submit", "owner-resubmit", "assigned-approver"] as const)(
    "%s freezes explicit empty and edited spec tables in the durable snapshot and exact retry", async (workflow) => {
      const saved = await fixture(workflow);
      const preview = await read(saved._id, workflow);
      preview.lots[0].condition_report_specs = {};
      preview.lots[0].condition_report_specs_manual_overrides = {};
      preview.lots[0].description = "Width: 20 ft; Manufacturer: old source";
      preview.lots[0].specifications = { Width: "20 ft" };
      preview.lots[1].condition_report_specs = { "Overall Width": "18 ft" };
      preview.lots[1].condition_report_specs_manual_overrides = { "Overall Width": "18 ft" };
      preview.lots[1].categories = "Portable Structures";
      const submitPath = workflow === "assigned-approver" ? `${previewPath(saved._id, workflow)}/resubmit`
        : `/api/asset/${saved._id}/${workflow === "owner-submit" ? "submit-approval" : "resubmit"}`;
      const accepted = await request(app).post(submitPath).set(headers(actorFor(workflow))).send({ preview_data: preview });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
      const persisted: any = await AssetReport.findById(saved._id).select("+report_job_outbox").lean();
      const snapshot = persisted.report_job_outbox.payload.previewDataSnapshot;
      for (const current of [snapshot, persisted.preview_data]) {
        expect(current.lots[0].condition_report_specs || {}).toEqual({});
        expect(current.lots[0].condition_report_specs_reviewed).toBe(true);
        expect(buildAuctioneerSpecRows(current.lots[0]).filter((row) => row.checked || row.value)).toEqual([]);
        expect(current.lots[1].condition_report_specs).toEqual({ "Overall Width": "18 ft" });
        expect(current.lots[1].condition_report_specs_reviewed).toBe(true);
      }
      const retry = await request(app).post(submitPath).set(headers(actorFor(workflow))).send({ preview_data: preview });
      expect(retry.status, JSON.stringify(retry.body)).toBe(202);
      const retried: any = await AssetReport.findById(saved._id).select("+report_job_outbox").lean();
      expect(retried.job_id).toBe(persisted.job_id);
      // Exact retry finishes a pending outbox handoff; the durable queue now owns
      // that same snapshot, so the embedded outbox can legitimately be cleared.
      const durableJob: any = await ReportJob.findOne({ type: "asset-preview-files" }).lean();
      expect(durableJob.payload.previewDataSnapshot).toEqual(snapshot);
      expect(await ReportJob.countDocuments()).toBe(1);
      expect(effects.analyze).not.toHaveBeenCalled();
    }
  );

  it.each(["owner-submit", "owner-resubmit", "assigned-approver"] as const)("%s preserves selected 4/8/9, all 100, then an individual override through save/reopen and generation intent", async (workflow) => {
    const saved = await fixture(workflow);
    const original = await read(saved._id, workflow);
    const selected = new Set(["4", "8", "9"]);
    const selectedValues = { condition: "Starts and Runs with Boost", completeness: "Incomplete Unit", legal: "Salvage" };
    let current = await saveAndRead(saved._id, workflow, applySelections(original, selected, selectedValues));
    expectUnchangedReportData(current, original);
    current.lots.forEach((lot: any, index: number) => {
      expect(lot.condition_report_selections).toEqual(selected.has(lot.lot_number) ? selectedValues : original.lots[index].condition_report_selections);
    });
    expect(current.lots[99].condition_report_selections || {}).toEqual({}); // No silent N/A defaults; Mongo may omit empty objects.
    for (const number of selected) expect(current.lots[Number(number) - 1].condition_report_specs["Running Condition"].toLowerCase()).toBe("starts and runs with boost");

    // Updating one bulk group must not reset either of the other groups.
    current = await saveAndRead(saved._id, workflow, applySelections(current, selected, { completeness: "Missing Parts" }));
    expect(current.lots[3].condition_report_selections).toEqual({ ...selectedValues, completeness: "Missing Parts" });
    const all = new Set<string>(current.lots.map((lot: any) => lot.lot_number));
    const allValues = { condition: "Does not Start or Run", completeness: "Missing Parts", legal: "No Title" };
    current = await saveAndRead(saved._id, workflow, applySelections(current, all, allValues));
    expectUnchangedReportData(current, original);
    current.lots.forEach((lot: any) => {
      expect(lot.condition_report_selections).toEqual(allValues);
      expect(lot.condition_report_specs["Running Condition"].toLowerCase()).toBe("does not start or run");
    });

    const override = { condition: "N/A", completeness: "Has Keys", legal: "N/A" };
    current = await saveAndRead(saved._id, workflow, applySelections(current, new Set(["9"]), override));
    current = await saveAndRead(saved._id, workflow, current);
    expectUnchangedReportData(current, original);
    expect(current.lots[8].condition_report_selections).toEqual(override);
    expect(current.lots[7].condition_report_selections).toEqual(allValues);
    expect(current.lots[8].condition_report_specs["Running Condition"]).toBeUndefined();
    expect(buildAuctioneerSpecRows(current.lots[8]).some((row) => row.field === "Running Condition")).toBe(false);
    const before: any = await AssetReport.findById(saved._id).select("+report_job_outbox").lean();
    expect(before.report_job_outbox).toBeUndefined();
    expect(before.status).toBe(saved.status);
    expect(before.imageUrls).toEqual(original.lots.flatMap((lot: any) => lot.image_urls));

    const submitPath = workflow === "assigned-approver" ? `${previewPath(saved._id, workflow)}/resubmit`
      : `/api/asset/${saved._id}/${workflow === "owner-submit" ? "submit-approval" : "resubmit"}`;
    const accepted = await request(app).post(submitPath).set(headers(actorFor(workflow))).send({ preview_data: current });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    const persisted: any = await AssetReport.findById(saved._id).select("+report_job_outbox").lean();
    expect(persisted.job_status).toBe("queued");
    expect(String(persisted.user)).toBe(String(owner._id));
    expect(persisted.report_job_outbox.type).toBe("asset-preview-files");
    const snapshot = persisted.report_job_outbox.payload.previewDataSnapshot;
    expectUnchangedReportData(snapshot, original);
    expect(snapshot.lots.map((lot: any) => lot.condition_report_selections)).toEqual(current.lots.map((lot: any) => lot.condition_report_selections));
    expect(snapshot.lots[8].condition_report_specs["Running Condition"]).toBeUndefined();
    expect(assetPreviewFingerprint(snapshot)).toBe(assetPreviewFingerprint(persisted.preview_data));
    expect(effects.queue).toHaveBeenCalledTimes(1);
    expect(effects.analyze).not.toHaveBeenCalled();
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(await AssetReport.countDocuments()).toBe(1);
  }, 30_000);

  it("does not give an unrelated user owner or assigned-approver mutation access", async () => {
    const saved = await fixture("owner-submit");
    const changed = applySelections(makePreview(), new Set(["4", "8", "9"]), { condition: "Starts and Runs" });
    const ownerRoute = await request(app).put(`/api/asset/${saved._id}/preview`).set(headers(approver)).send({ preview_data: changed });
    const assignedRoute = await request(app).put(`/api/reports/assigned-approvals/${saved._id}/preview`).set(headers(approver)).send({ preview_data: changed });
    expect(ownerRoute.status).toBe(404);
    expect(assignedRoute.status).toBe(404);
    expect((await read(saved._id, "owner-submit")).lots[3].condition_report_selections.condition).toBe("Unverified Running Condition");
    expect(effects.queue).not.toHaveBeenCalled();
  });
});
