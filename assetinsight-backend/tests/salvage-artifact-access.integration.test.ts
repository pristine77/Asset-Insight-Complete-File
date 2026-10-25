import { Readable } from "node:stream";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({ read: vi.fn(), email: vi.fn(), notify: vi.fn() }));
vi.mock("../src/utils/r2Storage/r2Upload.js", async (original) => ({
  ...await original<typeof import("../src/utils/r2Storage/r2Upload.js")>(),
  getR2ObjectStream: effects.read,
}));
vi.mock("../src/utils/sendVerificationEmail.js", async (original) => ({
  ...await original<typeof import("../src/utils/sendVerificationEmail.js")>(), sendEmail: effects.email,
}));
vi.mock("../src/service/notificationService.js", async (original) => ({
  ...await original<typeof import("../src/service/notificationService.js")>(), notifyUser: effects.notify,
}));

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let Salvage: typeof import("../src/models/salvage.model.js")["default"];
let Pdf: typeof import("../src/models/pdfReport.model.js")["default"];
let filterCurrent: typeof import("../src/service/reportReleaseService.js")["filterCurrentPdfReportArtifacts"];
let releaseGroup: typeof import("../src/service/reportReleaseService.js")["releaseReportGroupById"];
const kinds = ["pdf", "docx", "xlsx", "images"] as const;

const headers = (id: unknown) => ({ Authorization: `Bearer ${jwt.sign({ id: String(id) }, process.env.JWT_SECRET!, { expiresIn: "10m" })}` });
async function account(role: "user" | "admin" | "superadmin" = "user") {
  return User.create({ email: `salvage-${new mongoose.Types.ObjectId()}@example.test`, username: `user-${new mongoose.Types.ObjectId()}`, password: "not-a-login-fixture", role, isVerified: true, authProvider: "email" });
}
async function group(approvalStatus: "pending" | "approved" = "pending") {
  const owner = await account();
  const approver = await account("admin");
  const ids = Object.fromEntries(kinds.map((kind) => [kind, new mongoose.Types.ObjectId()]));
  const files = Object.fromEntries(kinds.map((kind) => [kind, `https://assetinsight.test/salvage/test-generation/report.${kind === "images" ? "zip" : kind}`]));
  const parent = await Salvage.create({
    user: owner._id, file_number: "SALVAGE-157", claim_number: "CLAIM-157", policy_number: "POLICY-157",
    report_date: new Date(), date_received: new Date(), next_report_due: new Date(),
    appraiser_name: "Appraiser", appraiser_phone: "123", appraiser_email: "test@example.test", adjuster_name: "Adjuster",
    insured_name: "Owner", company_name: "Test", company_address: "Test address", appraiser_comments: "Root old notes",
    imageUrls: ["https://assetinsight.test/saved-original.jpg"],
    workflow_version: 1, status: "pending_approval", revision: 3, artifact_generation: "job:attempt-1",
    artifact_ids: Object.fromEntries(Object.entries(ids).map(([kind, id]) => [kind, String(id)])), files, files_stale: false, files_generating: false, job_status: "done",
    preview_data: { file_number: "SALVAGE-157", make: "Reviewed Ford", appraiser_comments: "Latest saved review\nSecond line", valuation: { fairMarketValue: "CA$12,000" }, imageUrls: ["https://assetinsight.test/saved-original.jpg"] },
  });
  const records = await Pdf.create(kinds.map((kind) => ({
    _id: ids[kind], filename: `report.${kind === "images" ? "zip" : kind}`, address: "SALVAGE-157", fairMarketValue: "CA$10,000",
    user: owner._id, report: parent._id, reportModel: "SalvageReport", reportType: "Salvage", fileType: kind,
    filePath: files[kind], artifact_generation: "job:attempt-1", approval_assigned_to: approver._id,
    approvalStatus, release_status: "released",
  })));
  return { owner, approver, parent, records, ids, files };
}

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: Salvage } = await import("../src/models/salvage.model.js"));
  ({ default: Pdf } = await import("../src/models/pdfReport.model.js"));
  ({ filterCurrentPdfReportArtifacts: filterCurrent } = await import("../src/service/reportReleaseService.js"));
  ({ releaseReportGroupById: releaseGroup } = await import("../src/service/reportReleaseService.js"));
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  vi.clearAllMocks();
  effects.read.mockImplementation(async () => ({ stream: Readable.from(Buffer.from("fixture report")), contentType: "application/pdf", contentLength: 14 }));
  effects.email.mockResolvedValue(undefined);
  effects.notify.mockResolvedValue(undefined);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe.sequential("canonical Salvage artifact access", () => {
  it("recovers pending siblings using the original approval audit, not the retrier's identity", async () => {
    const { approver, parent, ids } = await group();
    const retrier = await account("superadmin");
    const reviewedAt = new Date("2026-09-08T09:00:00Z");
    await Pdf.updateOne({ _id: ids.pdf }, { $set: { approvalStatus: "approved", reviewedBy: approver._id, reviewedAt,
      salvage_review_acknowledgement: { revision: 3, limitation_codes: ["sample_limited"], note: "Original reviewer accepted the limitations.", reviewed_by: approver._id, reviewed_at: reviewedAt } } });
    const response = await request(app).patch(`/api/admin/reports/${ids.docx}/approve`).set(headers(retrier._id));
    expect(response.status).toBe(200);
    for (const row of await Pdf.find({ report: parent._id }).lean()) {
      expect(String(row.reviewedBy)).toBe(String(approver._id));
      expect(row.reviewedAt?.toISOString()).toBe(reviewedAt.toISOString());
      expect(String(row.salvage_review_acknowledgement?.reviewed_by)).toBe(String(approver._id));
    }
    expect(effects.email).not.toHaveBeenCalled();
  });

  it("uses one persisted winner's audit when two reviewers approve concurrently", async () => {
    const { approver, parent, ids } = await group();
    const other = await account("superadmin");
    await Salvage.updateOne({ _id: parent._id }, { $set: { "preview_data.assessment": { schemaVersion: 2, stale: false,
      limitations: [{ code: "sample_limited", acknowledgementRequired: true, message: "Small sample." }] } } });
    const results = await Promise.all([approver, other].map((actor) => request(app).patch(`/api/admin/reports/${ids.pdf}/approve`)
      .set(headers(actor._id)).send({ salvageReviewAcknowledgement: { baseRevision: 3, limitationCodes: ["sample_limited"], note: `Reviewed by ${actor._id}` } })));
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    const rows = await Pdf.find({ report: parent._id }).lean();
    expect(new Set(rows.map((row) => String(row.reviewedBy))).size).toBe(1);
    expect(new Set(rows.map((row) => row.reviewedAt?.toISOString())).size).toBe(1);
    for (const row of rows) {
      expect(String(row.salvage_review_acknowledgement?.reviewed_by)).toBe(String(row.reviewedBy));
      expect(row.salvage_review_acknowledgement?.note).toBe(`Reviewed by ${row.reviewedBy}`);
    }
    expect(effects.email).toHaveBeenCalledTimes(1);
  });

  it("requires revision-bound limitations review before releasing an enterprise assessment", async () => {
    const { approver, parent, ids } = await group();
    await Salvage.updateOne({ _id: parent._id }, { $set: {
      "preview_data.assessment": { schemaVersion: 2, stale: false, limitations: [
        { code: "as_is_insufficient", acknowledgementRequired: true, severity: "warning", message: "No verified salvage prices." },
      ] },
    } });
    const url = `/api/admin/reports/${ids.pdf}/approve`;
    const denied = await request(app).patch(url).set(headers(approver._id));
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ code: "SALVAGE_REVIEW_ACKNOWLEDGEMENT_REQUIRED", requiredLimitationCodes: ["as_is_insufficient"] });
    expect(await Pdf.countDocuments({ report: parent._id, approvalStatus: "approved" })).toBe(0);
    expect(effects.email).not.toHaveBeenCalled();
    const acknowledgement = { baseRevision: 3, limitationCodes: ["as_is_insufficient"], note: "Reviewed; salvage value remains unavailable pending verified sale evidence." };
    const stale = await request(app).patch(url).set(headers(approver._id)).send({ salvageReviewAcknowledgement: { ...acknowledgement, baseRevision: 2 } });
    expect(stale.status).toBe(409);
    const approved = await request(app).patch(url).set(headers(approver._id)).send({ salvageReviewAcknowledgement: acknowledgement });
    expect(approved.status).toBe(200);
    for (const row of await Pdf.find({ report: parent._id }).lean()) {
      expect(row).toMatchObject({ approvalStatus: "approved", release_status: "released",
        salvage_review_acknowledgement: { revision: 3, limitation_codes: ["as_is_insufficient"], note: acknowledgement.note } });
      expect(String(row.salvage_review_acknowledgement?.reviewed_by)).toBe(String(approver._id));
    }
    expect((await request(app).patch(url).set(headers(approver._id))).body.already_processed).toBe(true);
    expect(effects.email).toHaveBeenCalledTimes(1);
  });

  it.each(["admin", "superadmin"] as const)("%s releases all four Salvage artifacts with one approval and no release-manager step", async (role) => {
    const { owner, approver, parent, ids } = await group();
    const manager = await account();
    await User.updateOne({ _id: owner._id }, { $set: { releaseManager: manager._id } });
    const actor = role === "admin" ? approver : await account("superadmin");
    await Pdf.updateMany({ report: parent._id }, { $set: { release_status: "pending_release", release_assigned_to: manager._id, release_assignment_email_sent_at: new Date() } });
    expect((await request(app).patch(`/api/admin/reports/${ids.pdf}/approve`).set(headers(owner._id))).status).toBe(403);
    const response = await request(app).patch(`/api/admin/reports/${ids.docx}/approve`).set(headers(actor._id));
    expect(response.status).toBe(200);
    const rows = await Pdf.find({ report: parent._id }).lean();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({ approvalStatus: "approved", release_status: "released", release_assigned_source: "auto_released", release_assigned_to: null, release_assignment_email_sent_at: null });
      expect(String(row.released_by)).toBe(String(actor._id));
      expect(row.released_at).toBeInstanceOf(Date);
    }
    expect(new Set(rows.map((row) => row.released_at?.getTime())).size).toBe(1);
    expect(effects.email).toHaveBeenCalledTimes(1);
    expect(effects.email.mock.calls[0][0]).toBe(owner.email);
    expect((await request(app).patch(`/api/admin/reports/${ids.xlsx}/approve`).set(headers(actor._id))).body.already_processed).toBe(true);
    expect(effects.email).toHaveBeenCalledTimes(1);
    for (const kind of kinds) {
      expect((await request(app).get(`/api/reports/${ids[kind]}/download`).set(headers(owner._id))).status).toBe(200);
    }
  });

  it("streams only the current published R2 object through the authenticated download", async () => {
    const { owner, ids } = await group("approved");
    const response = await request(app).get(`/api/reports/${ids.pdf}/download`).set(headers(owner._id));
    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(effects.read).toHaveBeenCalledExactlyOnceWith("asset-insight-test", "salvage/test-generation/report.pdf");
  });

  it("does not read storage for another owner or an unapproved sibling", async () => {
    const { owner, ids } = await group("approved");
    const other = await account();
    expect((await request(app).get(`/api/reports/${ids.pdf}/download`).set(headers(other._id))).status).toBe(403);
    await Pdf.updateOne({ _id: ids.xlsx }, { $set: { approvalStatus: "pending" } });
    const response = await request(app).get(`/api/reports/${ids.pdf}/download`).set(headers(owner._id));
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("AWAITING_APPROVAL");
    expect(effects.read).not.toHaveBeenCalled();
  });

  it.each([
    { files_stale: true }, { files_generating: true }, { job_status: "queued" },
    { job_status: "error" }, { artifact_generation: "new-job:new-attempt" }, { files: { pdf: "https://assetinsight.test/only.pdf" } },
  ])("blocks old/current file access when its parent is not ready: %j", async (state) => {
    const { owner, parent, ids } = await group("approved");
    await Salvage.updateOne({ _id: parent._id }, { $set: state });
    expect((await request(app).get(`/api/reports/${ids.pdf}/download`).set(headers(owner._id))).status).toBe(409);
    expect(effects.read).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary URL even when it was stored as the published pointer", async () => {
    const { owner, parent, ids } = await group("approved");
    await Pdf.updateOne({ _id: ids.pdf }, { $set: { filePath: "https://untrusted.example.test/internal" } });
    await Salvage.updateOne({ _id: parent._id }, { $set: { "files.pdf": "https://untrusted.example.test/internal" } });
    expect((await request(app).get(`/api/reports/${ids.pdf}/download`).set(headers(owner._id))).status).toBe(409);
    expect(effects.read).not.toHaveBeenCalled();
  });

  it("requires all four published Pdf rows before approval or download", async () => {
    const { owner, approver, ids } = await group();
    await Pdf.deleteOne({ _id: ids.xlsx });
    expect((await request(app).patch(`/api/admin/reports/${ids.pdf}/approve`).set(headers(approver._id))).status).toBe(409);
    await Pdf.updateMany({}, { $set: { approvalStatus: "approved" } });
    expect((await request(app).get(`/api/reports/${ids.pdf}/download`).set(headers(owner._id))).status).toBe(409);
    expect(effects.read).not.toHaveBeenCalled();
  });

  it("keeps old generation decisions out of approvals and scopes current approval to its four rows", async () => {
    const { approver, parent, ids, owner } = await group();
    const old = await Pdf.create({ filename: "old.pdf", address: "Old output", fairMarketValue: "1", user: owner._id, report: parent._id,
      reportModel: "SalvageReport", reportType: "Salvage", fileType: "pdf", filePath: "https://assetinsight.test/old.pdf", artifact_generation: "old-job:old-attempt", approvalStatus: "pending", approval_assigned_to: approver._id });
    const response = await request(app).get("/api/reports/assigned-approvals").set(headers(approver._id));
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]._id).not.toBe(String(old._id));
    expect((await request(app).patch(`/api/admin/reports/${old._id}/approve`).set(headers(approver._id))).status).toBe(409);
    expect((await request(app).patch(`/api/admin/reports/${ids.pdf}/approve`).set(headers(approver._id))).status).toBe(200);
    expect((await Pdf.findById(old._id).lean())?.approvalStatus).toBe("pending");
    expect(await Pdf.countDocuments({ artifact_generation: "job:attempt-1", approvalStatus: "approved" })).toBe(4);
  });

  it("returns the canonical saved preview only to the assigned reviewer without owner edit authority", async () => {
    const { owner, approver, ids, parent } = await group();
    await Salvage.updateOne({ _id: parent._id }, { $unset: { "preview_data.imageUrls": 1 } });
    const response = await request(app).get(`/api/reports/assigned-approvals/${ids.pdf}/preview`).set(headers(approver._id));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ reportType: "Salvage", read_only: true, revision: 3, imageUrls: ["https://assetinsight.test/saved-original.jpg"],
      preview_data: { make: "Reviewed Ford", appraiser_comments: "Latest saved review\nSecond line", valuation: { fairMarketValue: "CA$12,000" } } });
    expect((await request(app).get(`/api/reports/assigned-approvals/${ids.pdf}/preview`).set(headers(owner._id))).status).toBe(404);
    expect((await request(app).put(`/api/reports/assigned-approvals/${ids.pdf}/preview`).set(headers(approver._id)).send({ preview_data: { make: "Not authorized" } })).status).toBe(404);
  });

  it("excludes stale parent generations before counting and paginating pending approvals", async () => {
    const current = await group();
    const stale = await group();
    await Pdf.updateMany({ report: stale.parent._id }, { $set: { approval_assigned_to: current.approver._id } });
    await Salvage.updateOne({ _id: stale.parent._id }, { $set: { files_stale: true } });
    const response = await request(app).get("/api/admin/reports/pending?page=1&limit=1").set(headers(current.approver._id));
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items).toHaveLength(4);
    expect(response.body.items.every((row: any) => String(row.report) === String(current.parent._id))).toBe(true);
  });

  it("scopes rejection and release to the current generation without mutating preserved outputs", async () => {
    const { approver, parent, ids, owner } = await group();
    const old = await Pdf.create({ filename: "old.pdf", address: "Old", fairMarketValue: "1", user: owner._id, report: parent._id,
      reportModel: "SalvageReport", reportType: "Salvage", fileType: "pdf", filePath: "https://assetinsight.test/old.pdf", artifact_generation: "old:attempt", approvalStatus: "pending", approval_assigned_to: approver._id,
      release_status: "pending_release", release_assigned_to: approver._id });
    expect((await request(app).patch(`/api/admin/reports/${ids.pdf}/reject`).set(headers(approver._id)).send({ note: "Update damage details" })).status).toBe(200);
    expect(await Pdf.countDocuments({ artifact_generation: "job:attempt-1", approvalStatus: "rejected" })).toBe(4);
    expect((await Pdf.findById(old._id).lean())?.approvalStatus).toBe("pending");
    await Pdf.updateMany({ artifact_generation: "job:attempt-1" }, { $set: { approvalStatus: "approved", release_status: "pending_release", release_assigned_to: approver._id } });
    await releaseGroup(String(ids.pdf), approver);
    expect(await Pdf.countDocuments({ artifact_generation: "job:attempt-1", release_status: "released" })).toBe(4);
    expect((await Pdf.findById(old._id).lean())?.release_status).toBe("pending_release");
    await expect(releaseGroup(String(old._id), approver)).rejects.toMatchObject({ statusCode: 409, code: "FILES_UNAVAILABLE" });
  });

  it("preserves legacy artifacts while filtering unpublished and superseded canonical rows", async () => {
    const { records, parent, owner } = await group();
    const legacy = { _id: new mongoose.Types.ObjectId(), user: owner._id, report: new mongoose.Types.ObjectId(), reportType: "Salvage", reportModel: "SalvageReport" };
    const unpublished = { ...records[0].toObject(), _id: new mongoose.Types.ObjectId(), artifact_generation: "unpublished:attempt" };
    expect((await filterCurrent([legacy, unpublished, ...records.map((row) => row.toObject())])).map((row: any) => String(row._id))).toEqual([String(legacy._id), ...records.map((row) => String(row._id))]);
    await Salvage.updateOne({ _id: parent._id }, { $set: { files_stale: true } });
    expect(await filterCurrent([legacy, ...records.map((row) => row.toObject())])).toEqual([legacy]);
  });
});
