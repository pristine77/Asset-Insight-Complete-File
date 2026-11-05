/**
 * A draft is kept until its report's preview is ready (owner, 2026-11-05).
 *
 * Acceptance used to delete the server draft; processing then failed ("Duplicate
 * lot number 1") and Colin's Drafts list was empty. These tests pin the new
 * life of a sent draft: hidden while processing, deleted once the preview
 * exists, shown again with the reason when processing stops.
 */
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/sendVerificationEmail.js", () => ({ sendEmail: vi.fn() }));
vi.mock("../src/service/reportDraftMediaService.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, deleteDraftMediaObjects: vi.fn(async () => undefined) };
});
import ReportDraft from "../src/models/reportDraft.model.js";
import ReportUploadSession from "../src/models/reportUploadSession.model.js";
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import {
  keepDraftOfAcceptedUpload,
  markAcceptedReportDraftsSubmitted,
  reportOutcome,
  settleSubmittedReportDrafts,
  visibleReportDrafts,
} from "../src/service/submittedReportDraftService.js";
import { toReportDraftClient } from "../src/service/reportDraftService.js";
import { findContractLotConflicts } from "../src/service/contractLotUniquenessService.js";
import { deleteReportDraftByClientId, listReportDrafts } from "../src/controller/reportDraft.controller.js";

let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { await mongoose.connection.db!.dropDatabase(); });

const userId = () => new mongoose.Types.ObjectId();
async function report(user: mongoose.Types.ObjectId, fields: Record<string, unknown>, Model: any = AssetReport) {
  const _id = new mongoose.Types.ObjectId();
  await Model.collection.insertOne({ _id, user, contract_no: "95200", updatedAt: new Date(), ...fields });
  return _id;
}
async function draft(user: mongoose.Types.ObjectId, fields: Record<string, unknown> = {}) {
  return ReportDraft.create({ user, type: "asset", clientDraftId: "draft-1", title: "Dustin Hawkins", contractNo: "95200",
    normalizedContractNo: "95200", formData: { clientSubmissionId: "submission-1" }, lots: [{ lotNumber: "1" }], ...fields });
}
const read = (id: unknown) => ReportDraft.findById(id).lean() as Promise<any>;

describe("what the report says about its preview", () => {
  it("only a finished preview with lots is ready; anything stopped without one is failed", () => {
    expect(reportOutcome("asset", null)).toBe("missing");
    expect(reportOutcome("asset", { status: "processing", job_status: "queued" })).toBe("processing");
    expect(reportOutcome("asset", { status: "preview", job_status: "done", preview_data: { lots: [{ title: "A" }] } })).toBe("ready");
    expect(reportOutcome("asset", { status: "error", job_status: "error" })).toBe("failed");
    expect(reportOutcome("asset", { status: "error", job_status: "error", preview_data: { lots: [] } })).toBe("failed");
    // A preview that exists stays the way back even if file generation failed later.
    expect(reportOutcome("asset", { status: "error", job_status: "error", preview_data: { lots: [{ title: "A" }] } })).toBe("ready");
    expect(reportOutcome("asset", { status: "cancelled", job_status: "cancelled" })).toBe("failed");
  });
});

describe.sequential("marking a draft when its upload is accepted", () => {
  it("marks by draft id or by the submission id kept in its form data, never a later save", async () => {
    const user = userId();
    const reportId = await report(user, { status: "processing", job_status: "queued" });
    const byForm = await draft(user);
    const byId = await draft(user, { clientDraftId: "submission-2", formData: {} });
    const unrelated = await draft(user, { clientDraftId: "other", formData: { clientSubmissionId: "other" } });
    const acceptedAt = new Date(Date.now() + 1_000);
    await markAcceptedReportDraftsSubmitted({ userId: user, type: "asset", clientSubmissionIds: ["submission-1", "submission-2"],
      reportId, notUpdatedAfter: acceptedAt });
    for (const id of [byForm._id, byId._id]) {
      expect(await read(id)).toMatchObject({ submittedReportId: reportId, submittedReportType: "asset", submissionStatus: "processing" });
    }
    expect((await read(unrelated._id)).submittedReportId).toBeUndefined();
    // updatedAt stays the user's own save time.
    expect((await read(byForm._id)).updatedAt.getTime()).toBe(byForm.updatedAt.getTime());

    const later = await draft(user, { clientDraftId: "draft-later", formData: { clientSubmissionId: "submission-3" } });
    await markAcceptedReportDraftsSubmitted({ userId: user, type: "asset", clientSubmissionIds: ["submission-3"], reportId,
      notUpdatedAfter: new Date(later.updatedAt.getTime() - 1) });
    expect((await read(later._id)).submittedReportId).toBeUndefined();
  });
});

describe.sequential("settling a kept draft from its report", () => {
  it("deletes the draft and its hidden draft preview once the preview is ready", async () => {
    const user = userId();
    const reportId = await report(user, { status: "preview", job_status: "done", preview_data: { lots: [{ title: "Loader" }] } });
    const kept = await draft(user, { submittedReportId: reportId, submittedReportType: "asset", submissionStatus: "processing" });
    await report(user, { is_draft_preview: true, source_draft_id: kept._id, status: "preview" });
    await settleSubmittedReportDrafts({ reportId, reportType: "asset" });
    expect(await read(kept._id)).toBeNull();
    expect(await AssetReport.countDocuments({ source_draft_id: kept._id })).toBe(0);
  });

  it("shows the draft again with the reason when processing stopped without a preview", async () => {
    const user = userId();
    const message = "Duplicate lot number 1. Original photos are retained.";
    const reportId = await report(user, { status: "error", job_status: "error", job_error: message });
    const kept = await draft(user, { submittedReportId: reportId, submittedReportType: "asset", submissionStatus: "processing" });
    await settleSubmittedReportDrafts({ reportId, reportType: "asset" });
    expect(await read(kept._id)).toMatchObject({ submissionStatus: "failed", submissionError: message });
    expect((await read(kept._id)).submissionFailedAt).toBeInstanceOf(Date);
  });

  it("clears the markers when the report was deleted: an ordinary draft again", async () => {
    const user = userId();
    const kept = await draft(user, { submittedReportId: new mongoose.Types.ObjectId(), submittedReportType: "asset", submissionStatus: "failed" });
    await settleSubmittedReportDrafts({ reportId: kept.submittedReportId, reportType: "asset" });
    const after = await read(kept._id);
    expect(after.submittedReportId).toBeNull();
    expect(after.submissionStatus).toBeNull();
  });

  it("never deletes a draft for a lot listing whose only lots are the intake rows", async () => {
    const user = userId();
    const reportId = await report(user, { status: "error", job_status: "error", job_error: "Stopped", lots: [{ lot_number: "1" }] }, LotListing);
    const kept = await draft(user, { type: "lotListing", submittedReportId: reportId, submittedReportType: "lotListing", submissionStatus: "processing" });
    await settleSubmittedReportDrafts({ reportId, reportType: "lotListing" });
    expect(await read(kept._id)).toMatchObject({ submissionStatus: "failed" });
  });
});

describe.sequential("the Drafts list", () => {
  const reload = (ids: unknown[]) => ReportDraft.find({ _id: { $in: ids } }) as any;

  it("hides drafts still processing, shows failed ones, and fixes out-of-date ones", async () => {
    const user = userId();
    const processingReport = await report(user, { status: "processing", job_status: "processing" });
    const failedReport = await report(user, { status: "error", job_status: "error", job_error: "Stopped" });
    const readyReport = await report(user, { status: "preview", job_status: "done", preview_data: { lots: [{ title: "A" }] } });
    const ordinary = await draft(user, { clientDraftId: "ordinary", formData: {} });
    await draft(user, { clientDraftId: "hidden", submittedReportId: processingReport, submittedReportType: "asset", submissionStatus: "processing" });
    const failed = await draft(user, { clientDraftId: "failed", submittedReportId: failedReport, submittedReportType: "asset", submissionStatus: "failed", submissionError: "Stopped" });
    // A lost failure notice: still marked processing although its report failed.
    const lost = await draft(user, { clientDraftId: "lost", submittedReportId: failedReport, submittedReportType: "asset", submissionStatus: "processing" });
    await draft(user, { clientDraftId: "ready", submittedReportId: readyReport, submittedReportType: "asset", submissionStatus: "processing" });

    const visible = await visibleReportDrafts(await ReportDraft.find({ user }).sort({ updatedAt: -1 }) as any[], reload);
    const ids = visible.map((item: any) => item.clientDraftId).sort();
    expect(ids).toEqual(["failed", "lost", "ordinary"]);
    expect(visible.find((item: any) => item.clientDraftId === "lost")?.submissionStatus).toBe("failed");
    expect(await ReportDraft.exists({ clientDraftId: "ready" })).toBeNull();
    expect(String(failed._id)).toBeTruthy();
    expect(String(ordinary._id)).toBeTruthy();
    expect(String(lost._id)).toBeTruthy();
  });

  it("the client sees one plain note, never the raw markers", async () => {
    const user = userId();
    const reportId = new mongoose.Types.ObjectId();
    const kept = await draft(user, { submittedReportId: reportId, submittedReportType: "asset", submittedAt: new Date(),
      submissionStatus: "failed", submissionError: "Duplicate lot number 1." });
    const client = await toReportDraftClient(kept);
    expect(client.submission).toMatchObject({ status: "failed", reportId: String(reportId), reportType: "asset", message: "Duplicate lot number 1." });
    for (const key of ["submittedReportId", "submittedReportType", "submittedAt", "submissionStatus", "submissionError", "submissionFailedAt"]) {
      expect(client).not.toHaveProperty(key);
    }
    expect((await toReportDraftClient(await draft(user, { clientDraftId: "plain" }))).submission).toBeUndefined();
  });

  it("a kept draft is not counted as a duplicate of its own report's lots", async () => {
    const user = userId();
    const reportId = await report(user, { status: "processing" });
    await draft(user, { lots: [{ lotNumber: "1", lot_number: "1" }], submittedReportId: reportId, submittedReportType: "asset", submissionStatus: "processing" });
    const conflicts = await findContractLotConflicts({ contractNo: "95200", lots: [{ lot_number: "1" }], excludeReportId: String(reportId) } as any);
    expect(conflicts).toEqual([]);
    // Control: an ordinary draft with the same lot still counts.
    await draft(user, { clientDraftId: "ordinary", lots: [{ lotNumber: "1", lot_number: "1" }] });
    const withOrdinary = await findContractLotConflicts({ contractNo: "95200", lots: [{ lot_number: "1" }], excludeReportId: String(reportId) } as any);
    expect(withOrdinary.map((item) => item.sourceType)).toEqual(["draft"]);
  });
});

describe.sequential("a delete that arrives right after sending", () => {
  it("keeps the draft while its upload is accepted and processing; a user discard of an ordinary draft still deletes", async () => {
    const user = userId();
    const reportId = await report(user, { status: "processing", job_status: "queued" });
    const sent = await draft(user);
    await ReportUploadSession.collection.insertOne({ user, type: "asset", clientSubmissionId: "submission-1", reportId: String(reportId),
      jobId: "job-1", status: "queued", files: [], updatedAt: new Date() });
    expect(await keepDraftOfAcceptedUpload(await read(sent._id))).toBe(true);
    expect(await read(sent._id)).toMatchObject({ submittedReportId: reportId, submissionStatus: "processing" });

    const app = express();
    app.use((req: any, _res, next) => { req.userId = String(user); next(); });
    app.delete("/report-drafts/client/:clientDraftId", deleteReportDraftByClientId);
    app.get("/report-drafts", listReportDrafts);
    const kept = await request(app).delete("/report-drafts/client/draft-1?type=asset");
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ retained: true });
    expect(await read(sent._id)).not.toBeNull();
    expect((await request(app).get("/report-drafts")).body.data).toEqual([]);

    await draft(user, { clientDraftId: "ordinary-discard", formData: {} });
    const discarded = await request(app).delete("/report-drafts/client/ordinary-discard?type=asset");
    expect(discarded.status).toBe(200);
    expect(discarded.body.retained).toBeUndefined();
    expect(await ReportDraft.exists({ clientDraftId: "ordinary-discard" })).toBeNull();
  });

  it("a failed kept draft can be discarded by its user", async () => {
    const user = userId();
    const reportId = await report(user, { status: "error", job_status: "error", job_error: "Stopped" });
    await draft(user, { submittedReportId: reportId, submittedReportType: "asset", submissionStatus: "failed", submissionError: "Stopped" });
    const app = express();
    app.use((req: any, _res, next) => { req.userId = String(user); next(); });
    app.delete("/report-drafts/client/:clientDraftId", deleteReportDraftByClientId);
    const response = await request(app).delete("/report-drafts/client/draft-1?type=asset");
    expect(response.status).toBe(200);
    expect(await ReportDraft.exists({ clientDraftId: "draft-1" })).toBeNull();
  });
});
