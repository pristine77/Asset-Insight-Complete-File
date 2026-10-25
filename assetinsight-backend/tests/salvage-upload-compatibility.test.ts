import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupReportJobSourceFiles, readMulterFileBuffer } from "../src/utils/reportTempFiles.js";
import { buildReportJobOutbox, ensureReportJobOutbox } from "../src/utils/reportJobMongoQueue.js";
import { normalizeSalvageReportData } from "../src/service/salvageReportData.js";
import ReportJob from "../src/models/reportJob.model.js";
import SalvageReport from "../src/models/salvage.model.js";
import { buildSalvageAssessment } from "../src/service/salvageAssessment.js";
import { getReportPreviewPayloadById } from "../src/service/reportPreviewService.js";

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let owner: string;
const priorDevice = process.env.DEVICE_APPROVAL_ENFORCEMENT;
const details = {
  report_date: "2026-09-06", file_number: "QA-SALVAGE-001", date_received: "2026-09-06",
  claim_number: "QA-CLAIM-001", policy_number: "QA-POLICY-001", appraiser_name: "QA Appraiser",
  appraiser_phone: "1234567890", appraiser_email: "appraiser@example.test", adjuster_name: "QA Adjuster",
  insured_name: "QA Insured", company_name: "QA Company", company_address: "QA Address",
  appraiser_comments: "Compatibility test", next_report_due: "2026-09-07", language: "en", currency: "CAD",
};
const auth = (id = owner) => `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: "30m" })}`;
const create = (patch: any = {}) => request(app).post("/api/salvage").set("Authorization", auth()).field("details", JSON.stringify({ ...details, ...patch }));
async function cleanup() {
  for (const report of await SalvageReport.find().select("+source_files").lean() as any[]) await cleanupReportJobSourceFiles(report.source_files);
}
async function ready(patch: any = {}) {
  const snapshot = normalizeSalvageReportData({ ...details, imageUrls: ["https://assetinsight.test/original.jpg"], item_type: "Truck", valuation: { fairMarketValue: "1200" } });
  return SalvageReport.create({ ...details, user: owner, workflow_version: 1, status: "preview", revision: 1, preview_data: snapshot,
    imageUrls: snapshot.imageUrls, job_status: "done", job_id: `completed-${new mongoose.Types.ObjectId()}`, files_stale: true, ...patch });
}

describe("owner-controlled Salvage processing", () => {
  it("saves enriched context without paid work, retains omitted notes, clears explicitly and matches admin evidence", async () => {
    const assessment = buildSalvageAssessment({ inputs: { year: 2018, make: "Ford", model: "F150", effectiveDate: "2026-09-06" } });
    const report = await ready({ assessment, assessment_inputs: assessment.inputs, preview_data: normalizeSalvageReportData({ ...details, assessment,
      imageUrls: ["https://assetinsight.test/original.jpg"], report_context: { intended_use: "Original purpose", pre_loss_condition: "Recorded owner statement" } }) });
    const id = String(report._id);
    const update = await request(app).patch(`/api/salvage/${id}/preview`).set("Authorization", auth()).send({ baseRevision: 1, data: {
      report_context: { intended_use: "Claim review", repair_estimate_date: "2026-09-06" },
      report_enrichment: { schemaVersion: 1, sections: [{ title: "Forged sale confirmation" }] },
      report_history: { revision: 999, events: [{ actor: "Forged signer" }] },
    } });
    expect(update.status).toBe(200);
    expect(update.body.data.preview_data.report_context).toEqual({ intended_use: "Claim review", pre_loss_condition: "Recorded owner statement", repair_estimate_date: "2026-09-06" });
    expect(update.body.data.preview_data.assessment.valuations).toEqual(assessment.valuations);
    expect(await ReportJob.countDocuments()).toBe(0);
    const cleared = await request(app).patch(`/api/salvage/${id}/preview`).set("Authorization", auth()).send({ baseRevision: 2, data: { report_context: { intended_use: null } } });
    expect(cleared.status).toBe(200);
    const reopened = (await request(app).get(`/api/salvage/${id}/preview`).set("Authorization", auth())).body.data;
    expect(reopened.preview_data.report_context).toMatchObject({ intended_use: null, pre_loss_condition: "Recorded owner statement" });
    const admin = await getReportPreviewPayloadById(id);
    expect(admin?.data.report_enrichment).toEqual(reopened.preview_data.report_enrichment);
    const visible = JSON.stringify(reopened.preview_data.report_enrichment);
    expect(visible).not.toMatch(/Forged|beforeHash|afterHash|Electronic review/);
    expect(reopened.preview_data.report_history.events).toHaveLength(2);
    expect(reopened.preview_data.report_history.events[1].revision).toBe(3);
    const stored: any = await SalvageReport.findById(id).select("+assessment_edit_history").lean();
    expect(stored.assessment_edit_history[1].reportContext.before.intended_use).toBe("Claim review");
    expect(stored.assessment_edit_history[1].reportContext.after.intended_use).toBeNull();
    expect(await ReportJob.countDocuments()).toBe(0);
  });
  it("rejects invalid context dates, unexpected approval fields and stale context revisions", async () => {
    const report = await ready(); const id = String(report._id);
    for (const report_context of [{ repair_estimate_date: "2026-02-30" }, { reviewer_signature: "Not authorized" }, { scope_of_work: "x".repeat(6001) }]) {
      expect((await request(app).patch(`/api/salvage/${id}/preview`).set("Authorization", auth()).send({ baseRevision: 1, data: { report_context } })).status).toBe(400);
    }
    expect((await request(app).patch(`/api/salvage/${id}/preview`).set("Authorization", auth()).send({ baseRevision: 0, data: { report_context: { client_comments: "Stale edit" } } })).status).toBe(409);
    expect((await SalvageReport.findById(id).lean())?.revision).toBe(1);
    expect(await ReportJob.countDocuments()).toBe(0);
  });
  it("retains the publication fence when queue cancellation loses its acknowledgement", async () => {
    const accepted = await create(); const id = accepted.body.reportId;
    const queue = vi.spyOn(ReportJob, "updateMany").mockRejectedValueOnce(new Error("Isolated queue acknowledgement failure"));
    const body = { baseRevision: 0, jobId: accepted.body.jobId };
    try {
      expect((await request(app).post(`/api/salvage/${id}/cancel`).set("Authorization", auth()).send(body)).status).toBe(500);
      const stopped: any = await SalvageReport.findById(id).select("+job_execution_token").lean();
      expect(stopped.job_status).toBe("cancelled"); expect(stopped.job_execution_token).toBe(`cancelled:${body.jobId}`);
      expect((await request(app).post(`/api/salvage/${id}/cancel`).set("Authorization", auth()).send(body)).status).toBe(200);
      const job: any = await ReportJob.findOne({ reportId: id }).lean();
      expect(job.status).toBe("cancelled"); expect(job.dedupeKey).toBeUndefined();
    } finally { queue.mockRestore(); }
  });
  it("releases a late cancelled job's dedupe claim after a newer run has already been accepted", async () => {
    await ReportJob.createIndexes();
    const original = await ready({ job_status: "queued", generation_kind: "preview", status: "processing" });
    const id = String(original._id), oldToken = original.job_id!;
    const makeOutbox = (token: string) => buildReportJobOutbox({ type: "salvage-preview", reportId: id, progressId: token,
      idempotencyKey: token, token, payload: { generationToken: token, revision: 1 } });
    await SalvageReport.updateOne({ _id: id }, { $set: { report_job_outbox: makeOutbox(oldToken) } });
    let release!: () => void, reached!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const beforeInsert = new Promise<void>(resolve => { reached = resolve; });
    const insert = ReportJob.findOneAndUpdate.bind(ReportJob);
    const spy = vi.spyOn(ReportJob, "findOneAndUpdate").mockImplementationOnce((async (...args: any[]) => {
      reached(); await waiting; return (insert as any)(...args);
    }) as any);
    const delayed = ensureReportJobOutbox("salvage", id, oldToken);
    try {
      await beforeInsert;
      const stopped = await request(app).post(`/api/salvage/${id}/cancel`).set("Authorization", auth()).send({ baseRevision: 1, jobId: oldToken });
      expect(stopped.status).toBe(200);
      // Equivalent to an accepted retry whose outbox dispatch is temporarily delayed.
      const newToken = `${oldToken}-resumed`;
      await SalvageReport.updateOne({ _id: id }, { $set: { job_id: newToken, job_status: "queued", report_job_outbox: makeOutbox(newToken) }, $unset: { job_execution_token: 1 } });
      release(); await delayed;
      const stale: any = await ReportJob.findOne({ idempotencyKey: oldToken }).lean();
      expect(stale.status).toBe("cancelled"); expect(stale.dedupeKey).toBeUndefined();
      await ensureReportJobOutbox("salvage", id, newToken);
      expect(await ReportJob.countDocuments({ reportId: id, status: "queued" })).toBe(1);
      expect((await ReportJob.findOne({ reportId: id, status: "queued" }).lean())?.payload.generationToken).toBe(newToken);
    } finally { release(); await delayed.catch(() => undefined); spy.mockRestore(); }
  });
  it("stops an accepted upload, retains sources, resumes the same report and rejects a stale stop", async () => {
    const accepted = await create({ client_submission_id: "stop-and-resume" })
      .attach("images", Buffer.from("retained-original"), { filename: "original.jpg", contentType: "image/jpeg" });
    const id = accepted.body.reportId;
    const first = (await request(app).get(`/api/salvage/${id}/preview`).set("Authorization", auth())).body.data;
    expect(first).toMatchObject({ preview_available: false, can_cancel: true, workflow_steps: [{ key: "queued", status: "active" }] });
    const stop = () => request(app).post(`/api/salvage/${id}/cancel`).set("Authorization", auth()).send({ baseRevision: 0, jobId: first.job_id });
    const stopped = await stop();
    expect(stopped.status).toBe(200);
    expect(stopped.body.data).toMatchObject({ status: "cancelled", workflow_stage: "stopped", can_cancel: false,
      preview_available: false, downloadable: false, workflow_progress_percent: 0, workflow_steps: [{ key: "queued", status: "cancelled" }] });
    expect((await stop()).status).toBe(200);
    const stored: any = await SalvageReport.findById(id).select("+source_files +job_execution_token +report_job_outbox").lean();
    expect((await readMulterFileBuffer(stored.source_files[0])).toString()).toBe("retained-original");
    expect(stored.job_execution_token).toBe(`cancelled:${first.job_id}`);
    expect(stored.report_job_outbox).toBeUndefined();
    const oldJob: any = await ReportJob.findOne({ reportId: id }).lean();
    expect(oldJob.status).toBe("cancelled"); expect(oldJob.dedupeKey).toBeUndefined();
    expect((await request(app).get(`/api/salvage/progress/${first.job_id}`).set("Authorization", auth())).body.phase).toBe("cancelled");
    const resumed = await request(app).post(`/api/salvage/${id}/retry`).set("Authorization", auth()).send({ baseRevision: 0 });
    expect(resumed.status).toBe(202); expect(resumed.body.reportId).toBe(id); expect(resumed.body.jobId).not.toBe(first.job_id);
    expect(await ReportJob.countDocuments({ reportId: id, status: "queued" })).toBe(1);
    expect((await stop()).body.code).toBe("SALVAGE_GENERATION_CONFLICT");
    expect((await SalvageReport.findById(id).lean())?.job_id).toBe(resumed.body.jobId);
  });

  it("can stop files, reopen and save the preview, then resubmit and stop again without duplicate jobs", async () => {
    const original = await ready();
    const id = String(original._id);
    const first = await request(app).post(`/api/salvage/${id}/submit`).set("Authorization", auth()).send({ baseRevision: 1 });
    expect(first.status).toBe(202);
    expect(first.body.data).toMatchObject({ preview_available: true, can_cancel: true });
    const stopped = await request(app).post(`/api/salvage/${id}/cancel`).set("Authorization", auth()).send({ baseRevision: 1, jobId: first.body.jobId });
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.preview_data).toEqual(first.body.data.preview_data);
    const edited = await request(app).patch(`/api/salvage/${id}/preview`).set("Authorization", auth()).send({ baseRevision: 1, data: { damage_description: "Reviewed after stopping" } });
    expect(edited.status).toBe(200); expect(edited.body.data.revision).toBe(2);
    const [a, b] = await Promise.all([1, 2].map(() => request(app).post(`/api/salvage/${id}/resubmit`).set("Authorization", auth()).send({ baseRevision: 2 })));
    expect([a.status, b.status].filter(status => status === 202).length).toBeGreaterThan(0);
    expect(await ReportJob.countDocuments({ reportId: id, status: "queued" })).toBe(1);
    const current: any = await SalvageReport.findById(id).lean();
    const stopAgain = await request(app).post(`/api/salvage/${id}/cancel`).set("Authorization", auth()).send({ baseRevision: 2, jobId: current.job_id });
    expect(stopAgain.status).toBe(200);
    expect(stopAgain.body.data.preview_data.damage_description).toBe("Reviewed after stopping");
    expect(await SalvageReport.countDocuments()).toBe(1);
  });

  it("does not stop another owner's report or accept missing/stale identity", async () => {
    const accepted = await create(); const id = accepted.body.reportId;
    expect((await request(app).post(`/api/salvage/${id}/cancel`).send({})).status).toBe(401);
    const other = String((await User.create({ email: "other-stop@example.test", username: "Other", companyName: "QA", authProvider: "email", password: "isolated-password", isVerified: true, role: "user" }))._id);
    expect((await request(app).post(`/api/salvage/${id}/cancel`).set("Authorization", auth(other)).send({ baseRevision: 0, jobId: accepted.body.jobId })).status).toBe(404);
    expect((await request(app).post(`/api/salvage/${id}/cancel`).set("Authorization", auth()).send({ baseRevision: 0 })).body.code).toBe("SALVAGE_GENERATION_CONFLICT");
    expect((await request(app).post(`/api/salvage/${id}/cancel`).set("Authorization", auth()).send({ baseRevision: 99, jobId: accepted.body.jobId })).body.code).toBe("SALVAGE_REVISION_CONFLICT");
    const completed = await ready();
    expect((await request(app).post(`/api/salvage/${completed._id}/cancel`).set("Authorization", auth()).send({ baseRevision: 1, jobId: completed.job_id })).body.code).toBe("SALVAGE_NOT_PROCESSING");
  });
});
beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
});
beforeEach(async () => {
  await cleanup(); await mongoose.connection.db!.dropDatabase();
  owner = String((await User.create({ email: "salvage-qa@example.test", username: "QA", companyName: "QA", authProvider: "email",
    password: "isolated-password", isVerified: true, role: "user" }))._id);
});
afterAll(async () => {
  await cleanup(); await mongoose.disconnect(); await mongo.stop();
  if (priorDevice === undefined) delete process.env.DEVICE_APPROVAL_ENFORCEMENT; else process.env.DEVICE_APPROVAL_ENFORCEMENT = priorDevice;
});

describe("durable Salvage upload admission", () => {
  it.each([0, 1, 10, 11, 30, 31, 49, 50])("accepts all %i originals in order before responding", async count => {
    let upload = create();
    for (let index = 0; index < count; index++) upload = upload.attach("images", Buffer.from(`original-${index}`), { filename: `photo-${index}.jpg`, contentType: "image/jpeg" });
    const response = await upload;
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ reportId: expect.any(String), jobId: expect.any(String), phase: "processing" });
    const report: any = await SalvageReport.findById(response.body.reportId).select("+source_files").lean();
    expect(String(report.user)).toBe(owner);
    expect(report.status).toBe("processing");
    expect(report.source_files).toHaveLength(count);
    expect(await Promise.all(report.source_files.map(async (file: any) => (await readMulterFileBuffer(file)).toString()))).toEqual(Array.from({ length: count }, (_, index) => `original-${index}`));
    expect(await ReportJob.countDocuments({ reportId: response.body.reportId, type: "salvage-preview" })).toBe(1);
    const listing = await request(app).get("/api/salvage").set("Authorization", auth());
    expect(listing.body.data[0]).toMatchObject({ files: {}, downloadable: false, workflow_stage: "preparing_preview" });
    expect(JSON.stringify(listing.body)).not.toMatch(/source_files|submission_fingerprint|report_job_outbox|job_execution_token|research_checkpoint|research_requests|assessment_edit_history/);
  });
  it.each(["client_submission_id", "progress_id", "progressId", "job_id"])("coalesces %s exact retries without restricting contract numbers", async alias => {
    const first = await create({ [alias]: "same-logical-work" });
    const second = await create({ [alias]: "same-logical-work" });
    expect(first.status).toBe(202); expect(second.body.reportId).toBe(first.body.reportId); expect(second.body.jobId).toBe(first.body.jobId);
    if (alias !== "client_submission_id") {
      expect(first.body.jobId).toBe("same-logical-work");
      expect((await request(app).get(`/api/salvage/progress/${first.body.jobId}`).set("Authorization", auth())).status).toBe(200);
    }
    expect(await ReportJob.countDocuments()).toBe(1);
    const changed = await create({ [alias]: "same-logical-work", item_type: "Changed" });
    expect(changed.status).toBe(409);
    const separate = await create({ [alias]: "separate-logical-work" });
    expect(separate.status).toBe(202); expect(separate.body.reportId).not.toBe(first.body.reportId);
  });
  it("coalesces simultaneous accepted retries at the unique parent ID", async () => {
    const [a, b] = await Promise.all([create({ client_submission_id: "race" }), create({ client_submission_id: "race" })]);
    expect(a.status).toBe(202); expect(b.status).toBe(202); expect(a.body.reportId).toBe(b.body.reportId);
    await ensureReportJobOutbox("salvage", a.body.reportId);
    expect(await SalvageReport.countDocuments()).toBe(1); expect(await ReportJob.countDocuments()).toBe(1);
  });
  it("retains originals when a committed upload loses its Mongo acknowledgement", async () => {
    const originalSave = SalvageReport.prototype.save;
    const save = vi.spyOn(SalvageReport.prototype, "save").mockImplementationOnce(async function (this: any, ...args: any[]) {
      await originalSave.apply(this, args as any);
      throw new Error("Simulated acknowledgement loss after commit");
    });
    try {
      const response = await create({ client_submission_id: "lost-ack" }).attach("images", Buffer.from("irreplaceable-original"), { filename: "original.jpg", contentType: "image/jpeg" });
      expect(response.status).toBe(500);
      const parent: any = await SalvageReport.findOne({ user: owner as any }).select("+source_files +report_job_outbox").lean();
      expect((await readMulterFileBuffer(parent.source_files[0])).toString()).toBe("irreplaceable-original");
      expect(parent.report_job_outbox.type).toBe("salvage-preview");
      await ensureReportJobOutbox("salvage", String(parent._id));
      expect(await ReportJob.countDocuments({ reportId: String(parent._id) })).toBe(1);
    } finally { save.mockRestore(); }
  });
  it("rejects the 51st image, invalid details and missing required fields before work", async () => {
    let upload = create();
    for (let index = 0; index < 51; index++) upload = upload.attach("images", Buffer.from("x"), { filename: `${index}.jpg`, contentType: "image/jpeg" });
    expect((await upload).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).post("/api/salvage").set("Authorization", auth()).field("details", "invalid")).status).toBe(400);
    expect((await create({ file_number: "" })).status).toBe(400);
    expect(await SalvageReport.countDocuments()).toBe(0); expect(await ReportJob.countDocuments()).toBe(0);
  });
  it("authenticates admission and refuses blocked accounts", async () => {
    expect((await request(app).post("/api/salvage").field("details", "{}")).status).toBe(401);
    await User.updateOne({ _id: owner }, { $set: { isBlocked: true } });
    expect((await create()).status).toBe(403); expect(await ReportJob.countDocuments()).toBe(0);
  });
  it("rejects ownership overrides and keeps progress owner-scoped and durable", async () => {
    const other = String(new mongoose.Types.ObjectId());
    const response = await create({ user: other, status: "approved", files: { pdf: "malicious" } });
    const report: any = await SalvageReport.findById(response.body.reportId).lean();
    expect(String(report.user)).toBe(owner); expect(report.status).toBe("processing"); expect(report.files).toBeUndefined();
    await SalvageReport.updateOne({ _id: report._id }, { $set: { generation_progress: { percent: 35 } } });
    const progress = await request(app).get(`/api/salvage/progress/${response.body.jobId}`).set("Authorization", auth());
    expect(progress.body).toMatchObject({ phase: "processing", serverProgress01: 0.35, result: { reportId: response.body.reportId, reportType: "Salvage" } });
    await SalvageReport.updateOne({ _id: report._id }, { $set: { user: new mongoose.Types.ObjectId() } });
    expect((await request(app).get(`/api/salvage/progress/${response.body.jobId}`).set("Authorization", auth())).status).toBe(404);
    expect((await request(app).get(`/api/salvage/${report._id}/preview`).set("Authorization", auth())).status).toBe(404);
    expect((await request(app).get("/api/salvage").set("Authorization", auth())).body.data).toEqual([]);
  });
});
describe("Salvage saved-review generation contract", () => {
  it("saves partial edits, keeps media/evidence, recalculates repairs and never queues on save", async () => {
    const report = await ready();
    const response = await request(app).patch(`/api/salvage/${report._id}/preview`).set("Authorization", auth()).send({ baseRevision: 1, data: {
      item_type: "Reviewed truck", appraiser_comments: "Reviewed\nsecond line", imageUrls: [], user: new mongoose.Types.ObjectId(), status: "approved",
      repair_items: [{ name: "Panel", quantity: 2, unit_price: 35, line_total: 999 }], actual_cash_value: "1,200", valuation: { fairMarketValue: "1250", summary: "Reviewed" },
    } });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ revision: 2, status: "preview", files: {} });
    expect(response.body.data.preview_data).toMatchObject({ item_type: "Reviewed truck", claim_number: details.claim_number, actual_cash_value: 1200,
      appraiser_comments: "Reviewed\nsecond line", repair_items: [{ line_total: 70 }], imageUrls: report.imageUrls });
    expect(await ReportJob.countDocuments()).toBe(0);
  });
  it("CAS rejects stale concurrent saves without losing the winning edits", async () => {
    const report = await ready();
    const edit = (item_type: string) => request(app).patch(`/api/salvage/${report._id}/preview`).set("Authorization", auth()).send({ baseRevision: 1, data: { item_type } });
    const responses = await Promise.all([edit("A"), edit("B")]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect(responses.find(r => r.status === 409)?.body.code).toBe("SALVAGE_REVISION_CONFLICT");
    expect((await SalvageReport.findById(report._id))?.revision).toBe(2);
  });
  it("validates money and required fields instead of silently saving invalid entries", async () => {
    const report = await ready();
    for (const data of [{ actual_cash_value: -1 }, { actual_cash_value: "not money" }, { file_number: "" }, { labour_breakdown: [{ hours: -2 }] },
      { repair_estimate: { taxes: "not money" } }, { repair_estimate: { shop_supplies: -1 } }, { valuation: [] },
      { repair_estimate: { parts_items: [{ quantity: -1 }] } }, { repair_items: [{ quantity: 1e200, unit_price: 1e200 }] }]) {
      const response = await request(app).patch(`/api/salvage/${report._id}/preview`).set("Authorization", auth()).send({ baseRevision: 1, data });
      expect(response.status).toBe(400);
    }
    expect((await SalvageReport.findById(report._id))?.revision).toBe(1);
  });
  it("submits the saved revision once, blocks edits during generation and rejects stale submit", async () => {
    const report = await ready();
    const url = `/api/salvage/${report._id}`;
    expect((await request(app).post(`${url}/submit`).set("Authorization", auth()).send({ baseRevision: 0 })).status).toBe(409);
    const first = await request(app).post(`${url}/submit`).set("Authorization", auth()).send({ baseRevision: 1 });
    const repeat = await request(app).post(`${url}/submit`).set("Authorization", auth()).send({ baseRevision: 1 });
    expect(first.status).toBe(202); expect(repeat.body.jobId).toBe(first.body.jobId);
    expect(first.body.data).toMatchObject({ files_generating: true, downloadable: false, workflow_stage: "generating_files" });
    expect(await ReportJob.countDocuments({ type: "salvage-files" })).toBe(1);
    expect((await request(app).patch(`${url}/preview`).set("Authorization", auth()).send({ baseRevision: 1, data: { item_type: "Collision" } })).status).toBe(409);
  });
  it("retries failed file generation on the same saved report without rerunning image analysis", async () => {
    const report = await ready({ status: "preview", job_status: "error", generation_kind: "files", job_error: "Failure" });
    const response = await request(app).post(`/api/salvage/${report._id}/retry`).set("Authorization", auth()).send({});
    expect(response.status).toBe(202); expect(response.body.reportId).toBe(String(report._id));
    expect(await ReportJob.countDocuments({ type: "salvage-files" })).toBe(1); expect(await ReportJob.countDocuments({ type: "salvage-preview" })).toBe(0);
    expect(response.body.data.preview_data.item_type).toBe("Truck");
  });
  it("clears failed file-generation state on a corrected save without bypassing initial analysis", async () => {
    const report = await ready({ status: "preview", generation_kind: "files", job_status: "error", job_error: "Failed export" });
    const response = await request(app).patch(`/api/salvage/${report._id}/preview`).set("Authorization", auth()).send({ baseRevision: 1, data: { item_type: "Corrected" } });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: "preview", workflow_stage: "preview_ready", revision: 2, job_error: "" });
    expect(await ReportJob.countDocuments()).toBe(0);
    await SalvageReport.updateOne({ _id: report._id }, { $unset: { preview_data: 1 }, $set: { generation_kind: "preview", status: "error", job_status: "error" } });
    expect((await request(app).patch(`/api/salvage/${report._id}/preview`).set("Authorization", auth()).send({ baseRevision: 2, data: { item_type: "Skip analysis" } })).status).toBe(409);
  });
  it("opens and upgrades legacy reports without requiring a migration", async () => {
    const report = await SalvageReport.create({ ...details, user: owner, item_type: "Legacy", aiExtractedDetails: { damage_description: "Existing evidence" }, imageUrls: ["https://legacy.test/photo.jpg"] });
    const response = await request(app).patch(`/api/salvage/${report._id}/preview`).set("Authorization", auth()).send({ baseRevision: 0, data: { item_type: "Reviewed legacy" } });
    expect(response.status).toBe(200); expect(response.body.data.preview_data).toMatchObject({ item_type: "Reviewed legacy", damage_description: "Existing evidence" });
  });
  it("recalculates assessment edits, preserves provider provenance and records appraiser overrides without paid research", async () => {
    const assessment = buildSalvageAssessment({ inputs: { year: 2020, make: "Ford", model: "F-150", province: "AB", market: "Calgary", effectiveDate: "2026-09-08" },
      photoFindings: [{ photoId: "photo-001", status: "analyzed", observations: ["Visible dent"], facts: [], uncertainties: [] }],
      generatedAt: "2026-09-08T12:00:00.000Z", research: { runId: "provider-run-original" } });
    const report = await ready({ assessment_inputs: assessment.inputs, assessment,
      preview_data: { ...details, year: "2020", make: "Ford", item_model: "F-150", assessment_inputs: assessment.inputs, assessment } });
    const response = await request(app).patch(`/api/salvage/${report._id}/preview`).set("Authorization", auth()).send({ baseRevision: 1, data: {
      make: "Chevrolet", assessment: { schemaVersion: 2, research: { runId: "forged" } },
      assessment_inputs: { market: "Edmonton", overrides: { asIs: { description: "Reviewed salvage value", amount: 1500, appraiserReason: "Reviewed against the supplied auction history." } } },
    } });
    expect(response.status).toBe(200);
    const saved = response.body.data.preview_data;
    expect(saved.assessment_inputs).toMatchObject({ year: 2020, make: "Chevrolet", model: "F-150", province: "AB", market: "Edmonton" });
    expect(saved.assessment).toMatchObject({ schemaVersion: 2, stale: true, generatedAt: assessment.generatedAt,
      researchedInputs: { make: "Ford", market: "Calgary" }, research: { runId: "provider-run-original" }, valuations: { asIs: { amount: 1500, status: "appraiser_override" } } });
    expect(saved.assessment.photoFindings).toEqual(assessment.photoFindings);
    expect(await ReportJob.countDocuments()).toBe(0);
    const parent: any = await SalvageReport.findById(report._id).select("+assessment_edit_history").lean();
    expect(parent.assessment_edit_history).toHaveLength(1);
    expect(parent.assessment_edit_history[0]).toMatchObject({ revision: 2, overrides: { after: { asIs: { amount: 1500 } } } });
    expect(String(parent.assessment_edit_history[0].actor)).toBe(owner);
    expect(JSON.stringify(response.body)).not.toContain("assessment_edit_history");
  });
  it("persists vehicle corrections and clears with photo evidence protected, category fields refreshed and no new job", async () => {
    const assessment = buildSalvageAssessment({ inputs: {}, vehiclePhotoExtraction: true,
      photoFindings: [{ photoId: "photo-001", status: "analyzed", observations: [], uncertainties: [], facts: [
        { field: "make", value: "Ford", evidence: "Ford badge", source: "observed" },
        { field: "year", value: "2020", evidence: "Year: 2020", source: "observed" },
        { field: "engineDisplacement", value: "2.0 L", evidence: "2.0 L engine label", source: "observed" },
      ] }] });
    const report = await ready({ assessment_inputs: assessment.inputs, assessment,
      preview_data: { ...details, assessment_inputs: assessment.inputs, assessment } });
    const save = (baseRevision: number, data: any) => request(app).patch(`/api/salvage/${report._id}/preview`).set("Authorization", auth()).send({ baseRevision, data });
    const response = await save(1, { assessment_inputs: { vehicleOverrides: { category: "Cars", make: "Chevrolet", engineDisplacement: null, "spec:Wheelbase": "120 in" } },
      assessment: { vehicleDetails: { fields: [{ key: "vin", value: "forged" }] } } });
    expect(response.status).toBe(200);
    const saved = response.body.data.preview_data;
    expect(saved.assessment.vehicleDetails.category).toBe("Cars");
    expect(saved.assessment.vehicleDetails.fields.some((f: any) => f.key === "spec:Door Count")).toBe(true);
    expect(saved.assessment.vehicleDetails.fields.find((f: any) => f.key === "engineDisplacement")).toMatchObject({ value: null, status: "manual" });
    expect(saved.assessment.photoFindings).toEqual(assessment.photoFindings);
    expect(saved.assessment_inputs.make).toBe("Chevrolet"); expect(saved.make).toBe("Chevrolet");
    expect(saved.assessment.inputs).toEqual(saved.assessment_inputs);
    expect(saved.assessment.stale).toBe(true);
    expect((await save(2, { ...saved, make: "GMC" })).status).toBe(200);
    const persisted: any = await SalvageReport.findById(report._id).select("+assessment_edit_history").lean();
    expect(persisted.assessment_inputs.vehicleOverrides).toMatchObject({ make: "GMC", engineDisplacement: null, "spec:Wheelbase": "120 in" });
    expect(persisted.assessment_edit_history[1].vehicleOverrides.after.make).toBe("GMC");
    expect(persisted.assessment_inputs.vehicleOverrides).not.toHaveProperty("year");
    expect(persisted.assessment.vehicleDetails.fields.find((f: any) => f.key === "year").status).toBe("observed");
    expect((await save(3, { assessment_inputs: { vehicleOverrides: { vin: "invented" } } })).status).toBe(400);
    expect((await save(3, { assessment_inputs: { vehicleOverrides: { "unknownField": "invented" } } })).status).toBe(400);
    for (const [revision, value] of [[3, "GM"], [4, "Ford"]] as const) {
      const aliasSave = await save(revision, { assessment_inputs: { vehicleOverrides: { engineManufacturer: value } } });
      expect(aliasSave.status).toBe(200);
      expect(aliasSave.body.data.preview_data.assessment_inputs.vehicleOverrides.engineMake).toBe(value);
    }
    expect(await ReportJob.countDocuments()).toBe(0);
    const preview = await getReportPreviewPayloadById(String(report._id));
    expect((preview?.data.assessment as any).vehicleDetails.fields.find((f: any) => f.key === "engineMake").value).toBe("Ford");
    expect((preview?.data.assessment as any).vehicleDetails.fields.find((f: any) => f.key === "vin")).toMatchObject({ value: null, evidence: [] });
  });
  it("keeps actual legacy edits when a full-form save echoes untouched canonical inputs", async () => {
    const assessment = buildSalvageAssessment({ inputs: { year: 2020, make: "Ford", model: "F-150",
      repairItems: [{ description: "Panel", quantity: 1, unitPrice: 100, appraiserReason: "Appraiser checked the repair quote." }] } });
    const report = await ready({ assessment_inputs: assessment.inputs, assessment,
      preview_data: { ...details, assessment_inputs: assessment.inputs, assessment } });
    const response = await request(app).patch(`/api/salvage/${report._id}/preview`).set("Authorization", auth()).send({ baseRevision: 1,
      data: { assessment_inputs: assessment.inputs, make: "Chevrolet", repair_items: [{ name: "Panel", quantity: 2, unit_price: 100 }] } });
    expect(response.status).toBe(200);
    expect(response.body.data.preview_data.assessment_inputs).toMatchObject({ make: "Chevrolet", repairItems: [{ quantity: 2 }] });
    expect(response.body.data.preview_data.make).toBe("Chevrolet");
    expect(response.body.data.preview_data.assessment.stale).toBe(true);
    expect(await ReportJob.countDocuments()).toBe(0);
  });
  it("rejects malformed assessment inputs and unsupported legacy financial edits instead of storing contradictory values", async () => {
    const assessment = buildSalvageAssessment({ inputs: { year: 2020, make: "Ford", model: "F-150", province: "AB", market: "Calgary", effectiveDate: "2026-09-08" } });
    const report = await ready({ assessment_inputs: assessment.inputs, assessment,
      preview_data: { ...details, assessment_inputs: assessment.inputs, assessment, actual_cash_value: 0 } });
    for (const data of [
      { actual_cash_value: 10000 }, { recommended_reserve: 1000 }, { valuation: { fairMarketValue: "5000" } },
      { assessment_inputs: { year: 500 } }, { assessment_inputs: { province: "ZZ" } },
      { assessment_inputs: { odometer: -10 } }, { assessment_inputs: { effectiveDate: "2026-02-30" } },
      { assessment_inputs: { overrides: { asIs: { amount: -10 } } } },
      { assessment_inputs: { repairItems: [{ description: "Panel", quantity: 1, unitPrice: -1 }] } },
      { assessment_inputs: { suppliedComparables: Array.from({ length: 21 }, () => ({})) } },
    ]) {
      const response = await request(app).patch(`/api/salvage/${report._id}/preview`).set("Authorization", auth()).send({ baseRevision: 1, data });
      expect(response.status).toBe(400);
    }
    expect((await SalvageReport.findById(report._id))?.revision).toBe(1);
    expect(await ReportJob.countDocuments()).toBe(0);
  });
});

describe("explicit revision-checked Salvage research", () => {
  it("exposes assessment limitations and the current revision to admin review without private checkpoints", async () => {
    const assessment = buildSalvageAssessment({ inputs: { year: 2020, make: "Ford", model: "F-150" } });
    const report = await ready({ assessment, assessment_inputs: assessment.inputs, revision: 7,
      research_checkpoint: { internal_provider_body: "hidden" },
      preview_data: { ...details, assessment, assessment_inputs: assessment.inputs } });
    const preview = await getReportPreviewPayloadById(String(report._id));
    expect(preview).toMatchObject({ reportId: String(report._id), revision: 7, data: { assessment: { schemaVersion: 2 }, assessment_inputs: { make: "Ford" } } });
    expect((preview?.data.assessment as typeof assessment).limitations).toEqual(assessment.limitations);
    expect(JSON.stringify(preview)).not.toMatch(/research_checkpoint|internal_provider_body/);
  });
  it("requires authentication, ownership, a current revision and a stable request identity", async () => {
    const report = await ready(); const url = `/api/salvage/${report._id}/research`;
    expect((await request(app).post(url).send({ baseRevision: 1, client_request_id: "run-1" })).status).toBe(401);
    expect((await request(app).post(url).set("Authorization", auth()).send({ baseRevision: 0, client_request_id: "run-1" })).status).toBe(409);
    expect((await request(app).post(url).set("Authorization", auth()).send({ baseRevision: 1 })).status).toBe(400);
    await SalvageReport.updateOne({ _id: report._id }, { $set: { user: new mongoose.Types.ObjectId() } });
    expect((await request(app).post(url).set("Authorization", auth()).send({ baseRevision: 1, client_request_id: "run-1" })).status).toBe(404);
    expect(await ReportJob.countDocuments()).toBe(0);
  });
  it("coalesces simultaneous and completed replays without starting a second paid run", async () => {
    const report = await ready({ research_checkpoint: { } });
    const send = (baseRevision = 1, client_request_id = "same-research") => request(app).post(`/api/salvage/${report._id}/research`)
      .set("Authorization", auth()).send({ baseRevision, client_request_id });
    const [first, second] = await Promise.all([send(), send()]);
    expect(first.status).toBe(202); expect(second.status).toBe(202); expect(second.body.jobId).toBe(first.body.jobId);
    expect(first.body.data).toMatchObject({ revision: 1, status: "processing", downloadable: false });
    expect(await ReportJob.countDocuments({ type: "salvage-preview" })).toBe(1);
    const accepted: any = await SalvageReport.findById(report._id).select("+research_checkpoint +research_requests").lean();
    expect(accepted.research_checkpoint).toBeUndefined(); expect(accepted.research_requests).toHaveLength(1);
    expect(JSON.stringify(first.body)).not.toMatch(/research_requests|research_checkpoint/);
    expect((await send(1, "different-research")).status).toBe(409);
    await SalvageReport.updateOne({ _id: report._id }, { $set: { job_status: "done", status: "preview", revision: 2 } });
    expect((await send()).status).toBe(202);
    expect(await ReportJob.countDocuments({ type: "salvage-preview" })).toBe(1);
    expect((await send(2)).status).toBe(409);
    const next = await send(2, "new-explicit-research");
    expect(next.status).toBe(202); expect(next.body.jobId).not.toBe(first.body.jobId);
    expect(await ReportJob.countDocuments({ type: "salvage-preview" })).toBe(2);
  });
  it("keeps the same research checkpoint on a failed retry and does not accept another initial-analysis bypass", async () => {
    const checkpoint = { startedAt: "2026-09-08T12:00:00.000Z" };
    const report = await ready({ generation_kind: "preview", job_status: "error", status: "error", research_checkpoint: checkpoint });
    const response = await request(app).post(`/api/salvage/${report._id}/retry`).set("Authorization", auth()).send({});
    expect(response.status).toBe(202);
    const parent: any = await SalvageReport.findById(report._id).select("+research_checkpoint").lean();
    expect(parent.research_checkpoint).toEqual(checkpoint);
    expect(await ReportJob.countDocuments({ type: "salvage-preview" })).toBe(1);
    await SalvageReport.updateOne({ _id: report._id }, { $unset: { preview_data: 1 }, $set: { job_status: "error", status: "error" } });
    expect((await request(app).post(`/api/salvage/${report._id}/research`).set("Authorization", auth()).send({ baseRevision: 1, client_request_id: "not-ready" })).status).toBe(409);
  });
});
