import fs from "node:fs/promises";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import PizZip from "pizzip";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SalvageReport from "../src/models/salvage.model.js";
import PdfReport from "../src/models/pdfReport.model.js";
import { normalizeSalvageReportData } from "../src/service/salvageReportData.js";
import { buildSalvageAssessment } from "../src/service/salvageAssessment.js";
import { cancelSalvageProcessing, salvageRow } from "../src/service/salvageWorkflowService.js";
import { runSalvageFilesJob, runSalvagePreviewJob } from "../src/jobs/salvageReportJob.js";
import { ReportJobOwnershipLostError, type ReportJobExecutionContext } from "../src/utils/reportJobMongoQueue.js";

// No real image provider, storage, email, rendering process or production database
// is reachable from these orchestration tests. ZIP bytes remain local and synthetic.
const mocks = vi.hoisted(() => ({
  pipeline: vi.fn(), pdf: vi.fn(), docx: vi.fn(), xlsx: vi.fn(),
  upload: vi.fn(), uploadPath: vi.fn(), read: vi.fn(), readSource: vi.fn(), cleanup: vi.fn(),
  assign: vi.fn(), email: vi.fn(), zipEntries: [] as Array<{ name: string; bytes: string }>,
}));
vi.mock("../src/service/salvageResearchPipeline.js", () => ({ runEnterpriseSalvageAssessment: mocks.pipeline }));
vi.mock("../src/service/salvagePdfService.js", () => ({ generateSalvagePdfFromReport: mocks.pdf }));
vi.mock("../src/service/docx/salvageDocxBuilder.js", () => ({ generateSalvageDocx: mocks.docx }));
vi.mock("../src/service/xlsx/salvageXlsxService.js", () => ({ generateSalvageXlsx: mocks.xlsx }));
vi.mock("../src/service/approvalAssignmentService.js", () => ({ assignReportApprover: mocks.assign, sendAssignedApprovalEmail: mocks.email }));
vi.mock("../src/utils/reportTempFiles.js", () => ({ readMulterFileBuffer: mocks.readSource, cleanupReportJobSourceFiles: mocks.cleanup }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  getCurrentR2StorageTarget: () => ({ bucketName: "asset-insight-test", publicUrl: "https://assetinsight.test" }),
  uploadBufferToR2: mocks.upload, uploadFilePathToR2: mocks.uploadPath, readR2ObjectBuffer: mocks.read,
  resolveR2ObjectLocationFromUrl: (url: string) => url.startsWith("https://assetinsight.test/")
    ? { bucketName: "asset-insight-test", key: url.slice("https://assetinsight.test/".length) } : null,
}));

let mongo: MongoMemoryServer;
const details = {
  user: new mongoose.Types.ObjectId(), report_date: "2026-09-06", file_number: "ISOLATED-SALVAGE-001",
  date_received: "2026-09-06", claim_number: "CLAIM-TEST", policy_number: "POLICY-TEST",
  appraiser_name: "Test appraiser", appraiser_phone: "5551234567", appraiser_email: "qa@example.test",
  adjuster_name: "Test adjuster", insured_name: "Test insured", company_name: "Test company",
  company_address: "Test address", appraiser_comments: "Inspected by appraiser", next_report_due: "2026-09-07",
  language: "fr", currency: "EUR",
};
const photos = (count = 50) => Array.from({ length: count }, (_, i) => `https://assetinsight.test/originals/photo-${i + 1}.jpg`);
const context = (token = "attempt-one"): ReportJobExecutionContext => ({
  executionToken: token, signal: new AbortController().signal, assertOwned: vi.fn().mockResolvedValue(undefined),
});
const job = (report: any) => ({ reportId: String(report._id), payload: { generationToken: report.job_id, revision: report.revision } } as any);
const load = (id: any) => SalvageReport.findById(id).select("+source_files +job_execution_token +research_checkpoint").lean() as Promise<any>;
async function previewReport(count = 30, patch: Record<string, unknown> = {}) {
  return SalvageReport.create({ ...details, workflow_version: 1, status: "processing", generation_kind: "preview",
    job_id: "preview-generation", job_status: "queued", imageUrls: [], source_files: Array.from({ length: count }, (_, i) => ({
      originalname: "duplicate-camera-name.jpg", path: `isolated-original-${i}`, mimetype: "image/jpeg", size: 20,
    })), ...patch });
}
async function filesReport(patch: Record<string, unknown> = {}) {
  const preview_data = normalizeSalvageReportData({ ...details, imageUrls: photos(), item_type: "Reviewed truck", vin: "",
    damage_description: "Reviewed\nSecond line", actual_cash_value: 0,
    repair_items: [{ name: "Reviewed part", quantity: 2, unit_price: 35, line_total: 999 }],
    aiExtractedDetails: { item_type: "Incorrect AI truck", vin: "WRONG-VIN", actual_cash_value: 999, damage_description: "Wrong AI damage" },
    valuation: { fairMarketValue: "1250", confidence_level: "Low", summary: "Reviewed valuation" },
  });
  return SalvageReport.create({ ...details, workflow_version: 1, status: "preview", generation_kind: "files", revision: 3,
    preview_data, imageUrls: preview_data.imageUrls, job_id: "files-generation", job_status: "queued", files_generating: true, files_stale: true, ...patch });
}
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  vi.restoreAllMocks(); vi.resetAllMocks(); mocks.zipEntries = [];
  await mongoose.connection.db!.dropDatabase();
  mocks.pipeline.mockImplementation(async ({ imageUrls, onCheckpoint, onProgress }) => {
    await onCheckpoint({ schemaVersion: 1, stage: "complete" });
    await onProgress("Preparing valuation review", 90);
    return { item_type: "AI truck", vin: "READABLE-VIN", damage_description: "Visible damage", imageUrls,
      repair_estimate: { parts_items: [{ name: "Part", quantity: 2, unit_price: 40, line_total: 999 }] },
      comparableItems: [], valuation: { fairMarketValue: "Unavailable", confidence_level: "Low", summary: "Review required" },
      analysis_warning: "Comparable evidence unavailable; review required.", analysis_model: "gpt-6-astra" };
  });
  mocks.pdf.mockResolvedValue(Buffer.from("isolated-pdf")); mocks.docx.mockResolvedValue(Buffer.from("isolated-docx")); mocks.xlsx.mockResolvedValue(Buffer.from("isolated-xlsx"));
  mocks.readSource.mockImplementation(async (file: any) => Buffer.from(`bytes:${file.path}`));
  mocks.cleanup.mockResolvedValue(undefined); mocks.assign.mockResolvedValue(undefined); mocks.email.mockResolvedValue(undefined);
  mocks.read.mockImplementation(async (_bucket: string, key: string) => Buffer.from(`original:${key}`));
  mocks.upload.mockImplementation(async (_buffer: Buffer, _type: string, _bucket: string, key: string) => `https://assetinsight.test/${key}`);
  mocks.uploadPath.mockImplementation(async (filePath: string, _type: string, _bucket: string, key: string) => {
    const zip = new PizZip(await fs.readFile(filePath));
    mocks.zipEntries = Object.values(zip.files).filter(file => !file.dir).map(file => ({ name: file.name, bytes: file.asText() }));
    return `https://assetinsight.test/${key}`;
  });
});

describe("durable Salvage preview orchestration", () => {
  it("uploads all 50 unchanged originals in order, retains duplicates and lets supplied facts beat AI", async () => {
    const report = await previewReport(50, { item_type: "User reviewed truck", vin: "USER-VIN", actual_cash_value: 0 });
    await runSalvagePreviewJob(job(report), context());
    expect(mocks.upload).toHaveBeenCalledTimes(50);
    expect(mocks.upload.mock.calls.map(call => call[0].toString())).toEqual(Array.from({ length: 50 }, (_, i) => `bytes:isolated-original-${i}`));
    expect(mocks.upload.mock.calls.every(call => call[1] === "image/jpeg" && call[2] === "asset-insight-test")).toBe(true);
    const saved = await load(report._id);
    expect(saved.imageUrls).toHaveLength(50); expect(new Set(saved.imageUrls).size).toBe(50);
    expect(saved.imageUrls[0]).toContain("/originals/001-"); expect(saved.imageUrls[49]).toContain("/originals/050-");
    expect(mocks.pipeline).toHaveBeenCalledWith(expect.objectContaining({ imageUrls: saved.imageUrls,
      snapshot: expect.objectContaining({ item_type: "User reviewed truck", vin: "USER-VIN", language: "fr", currency: "EUR" }) }));
    expect(saved.preview_data).toMatchObject({ item_type: "User reviewed truck", vin: "USER-VIN", actual_cash_value: 0,
      repair_items: [{ name: "Part", line_total: 80 }], imageUrls: saved.imageUrls });
    expect(saved.research_checkpoint).toMatchObject({ stage: "complete" });
    expect(saved).toMatchObject({ status: "preview", revision: 1, job_status: "done", files_stale: true });
    expect(saved.source_files).toBeUndefined(); expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.pdf).not.toHaveBeenCalled(); expect(await PdfReport.countDocuments()).toBe(0);
  });
  it("resumes after a failed upload checkpoint without re-uploading successful originals", async () => {
    const report = await previewReport(4);
    mocks.upload.mockImplementationOnce(async (_bytes, _type, _bucket, key) => `https://assetinsight.test/${key}`)
      .mockRejectedValueOnce(new Error("isolated storage failure"));
    await expect(runSalvagePreviewJob(job(report), context())).rejects.toThrow("isolated storage failure");
    const partial = await load(report._id);
    expect(partial.imageUrls).toHaveLength(1); expect(partial.source_files).toHaveLength(4);
    expect(mocks.cleanup).not.toHaveBeenCalled(); expect(mocks.pipeline).not.toHaveBeenCalled();
    mocks.upload.mockClear();
    await runSalvagePreviewJob(job(report), context("retry-attempt"));
    expect(mocks.upload.mock.calls.map(call => call[0].toString())).toEqual(["bytes:isolated-original-1", "bytes:isolated-original-2", "bytes:isolated-original-3"]);
    expect((await load(report._id)).imageUrls[0]).toBe(partial.imageUrls[0]);
  });
  it("retains durable originals across analysis failures and retries without touching uploads", async () => {
    const report = await previewReport(2); mocks.pipeline.mockRejectedValueOnce(new Error("isolated AI failure"));
    await expect(runSalvagePreviewJob(job(report), context())).rejects.toThrow("isolated AI failure");
    const partial = await load(report._id); expect(partial.imageUrls).toHaveLength(2); expect(partial.preview_data).toBeUndefined();
    mocks.upload.mockClear(); await runSalvagePreviewJob(job(report), context("retry-attempt"));
    expect(mocks.upload).not.toHaveBeenCalled(); expect((await load(report._id)).status).toBe("preview");
  });
  it("persists execution intent before failure and passes that same checkpoint to retry", async () => {
    const checkpoint = { schemaVersion: 1, startedAt: "2026-09-08T12:00:00.000Z", stage: "research" };
    const report = await previewReport(0, { revision: 4, preview_data: { ...details, item_type: "Reviewed vehicle" } });
    mocks.pipeline.mockImplementationOnce(async ({ onCheckpoint }) => {
      await onCheckpoint(checkpoint);
      expect((await load(report._id)).research_checkpoint).toEqual(checkpoint);
      throw new Error("Ambiguous provider response");
    });
    await expect(runSalvagePreviewJob(job(report), context())).rejects.toThrow("Ambiguous provider response");
    await runSalvagePreviewJob(job(report), context("retry-attempt"));
    expect(mocks.pipeline.mock.calls[1][0]).toMatchObject({ checkpoint, snapshot: { item_type: "Reviewed vehicle" } });
    expect((await load(report._id)).revision).toBe(5);
  });
  it.each(["generation", "attempt", "revision"])("fences research checkpoint and completion against a replaced %s", async fence => {
    const report = await previewReport(0);
    mocks.pipeline.mockImplementationOnce(async ({ onCheckpoint }) => {
      const update = fence === "generation" ? { job_id: "replacement" } : fence === "attempt" ? { job_execution_token: "replacement" } : { revision: 9 };
      await SalvageReport.updateOne({ _id: report._id }, { $set: update });
      await onCheckpoint({ schemaVersion: 1, });
      return {};
    });
    await expect(runSalvagePreviewJob(job(report), context())).rejects.toBeInstanceOf(ReportJobOwnershipLostError);
    expect((await load(report._id)).preview_data).toBeUndefined();
  });
  it("supports report-only submissions and makes unavailable evidence explicit", async () => {
    const report = await previewReport(0);
    await runSalvagePreviewJob(job(report), context());
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.pipeline).toHaveBeenCalledWith(expect.objectContaining({ imageUrls: [] }));
    expect((await load(report._id)).preview_data).toMatchObject({ imageUrls: [], valuation: { fairMarketValue: "Unavailable", confidence_level: "Low" } });
    expect((await load(report._id)).analysis_warning).toContain("unavailable");
  });
  it("projects fresh canonical conclusions after old legacy financial fields and keeps unknown costs null", async () => {
    const assessment = buildSalvageAssessment({ inputs: { make: "Ford", model: "F-150", year: 2020,
      overrides: { preLoss: { amount: 10000, appraiserReason: "Reviewed actual pre-loss transaction evidence." }, asIs: { amount: 1500, appraiserReason: "Appraiser-supported as-is market evidence." } },
      repairItems: [{ description: "Panel", quantity: 2, unitPrice: 50, appraiserReason: "Current supplier quote verified by appraiser." }] } });
    const report = await previewReport(0, { revision: 2, actual_cash_value: 90000, recommended_reserve: 1000,
      preview_data: { ...details, actual_cash_value: 90000, recommended_reserve: 1000, valuation: { fairMarketValue: "9000" } } });
    mocks.pipeline.mockResolvedValueOnce({ assessment, assessment_inputs: assessment.inputs, actual_cash_value: 999999,
      repair_estimate: { total: 7777 }, valuation: { fairMarketValue: "9999" } });
    await runSalvagePreviewJob(job(report), context());
    const parent = await load(report._id);
    expect(parent.preview_data).toMatchObject({ currency: "CAD", actual_cash_value: 10000, replacement_cost: null, recommended_reserve: null,
      valuation: { fairMarketValue: "CAD 1500.00", net_auction_recovery: null }, repair_items: [{ line_total: 100 }], repair_estimate: { total: null } });
    expect(parent).toMatchObject({ revision: 3, actual_cash_value: 10000, recommended_reserve: null });
  });
  it("does not silently succeed when a retained local original is empty", async () => {
    const report = await previewReport(1); mocks.readSource.mockResolvedValueOnce(Buffer.alloc(0));
    await expect(runSalvagePreviewJob(job(report), context())).rejects.toThrow("original photo is missing");
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.cleanup).not.toHaveBeenCalled();
    expect((await load(report._id)).source_files).toHaveLength(1);
  });
});

describe("durable Salvage saved-preview artifact publication", () => {
  it("fences a running renderer after cancellation without publishing, deleting photos or sending notifications", async () => {
    const report = await filesReport();
    const before = await load(report._id);
    mocks.pdf.mockImplementationOnce(async () => {
      await cancelSalvageProcessing(await load(report._id), 3, report.job_id);
      return Buffer.from("finished-in-flight-render");
    });
    await expect(runSalvageFilesJob(job(report), context())).rejects.toBeInstanceOf(ReportJobOwnershipLostError);
    expect(mocks.docx).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.email).not.toHaveBeenCalled();
    expect(await PdfReport.countDocuments()).toBe(0);
    const stored = await load(report._id);
    expect(stored.job_status).toBe("cancelled"); expect(stored.preview_data).toEqual(before.preview_data);
    expect(stored.imageUrls).toHaveLength(50); expect(stored.files).toBeUndefined();
    const row = await salvageRow(stored);
    expect(row.workflow_steps).toEqual([{ key: "pdf", label: "Creating PDF report", status: "cancelled" }]);
  });

  it("rejects a checkpoint and final publication from a stopped research attempt", async () => {
    const report = await previewReport(1);
    mocks.pipeline.mockImplementationOnce(async ({ onCheckpoint }) => {
      await cancelSalvageProcessing(await load(report._id), 0, report.job_id);
      await onCheckpoint({ schemaVersion: 1, stages: { fabricatedLate: true } });
      return {};
    });
    await expect(runSalvagePreviewJob(job(report), context())).rejects.toBeInstanceOf(ReportJobOwnershipLostError);
    const stopped = await load(report._id);
    expect(stopped.job_status).toBe("cancelled"); expect(stopped.preview_data).toBeUndefined();
    expect(stopped.research_checkpoint).toBeUndefined(); expect(stopped.imageUrls).toHaveLength(1);
    await expect(runSalvagePreviewJob(job(report), context("stale-reclaim"))).rejects.toBeInstanceOf(ReportJobOwnershipLostError);
  });
  it("passes identical Canadian assessment conclusions, unknowns and evidence to every renderer", async () => {
    const assessment = buildSalvageAssessment({ inputs: { year: 2020, make: "Ford", model: "F-150", province: "AB", market: "Calgary", effectiveDate: "2026-09-08" } });
    const report = await filesReport({ assessment, assessment_inputs: assessment.inputs,
      preview_data: { ...details, assessment, assessment_inputs: assessment.inputs, actual_cash_value: 9999, repair_estimate: { total: 9999 } } });
    await runSalvageFilesJob(job(report), context());
    const snapshot = mocks.pdf.mock.calls[0][0];
    expect(snapshot).toMatchObject({ assessment: { schemaVersion: 2 }, actual_cash_value: null, replacement_cost: null,
      recommended_reserve: null, repair_estimate: { total: null }, valuation: { fairMarketValue: "Unavailable" }, imageUrls: photos() });
    expect(mocks.docx).toHaveBeenCalledWith(snapshot); expect(mocks.xlsx).toHaveBeenCalledWith(snapshot);
    expect(mocks.pipeline).not.toHaveBeenCalled(); expect(mocks.zipEntries).toHaveLength(50);
  });
  it("passes one reviewed snapshot to all three renderers and publishes exactly four complete artifacts", async () => {
    const report = await filesReport(); await runSalvageFilesJob(job(report), context());
    const snapshot = mocks.pdf.mock.calls[0][0];
    expect(snapshot).toMatchObject({ item_type: "Reviewed truck", vin: "", actual_cash_value: 0, repair_items: [{ line_total: 70 }],
      damage_description: "Reviewed\nSecond line", repair_estimate: { total: 70 }, imageUrls: photos() });
    expect(snapshot.aiExtractedDetails.vin).toBe("");
    expect(mocks.docx).toHaveBeenCalledWith(snapshot); expect(mocks.xlsx).toHaveBeenCalledWith(snapshot);
    expect(mocks.pipeline).not.toHaveBeenCalled();
    expect(mocks.zipEntries).toEqual(photos().map((_, i) => ({ name: `photo-${String(i + 1).padStart(3, "0")}.jpg`, bytes: `original:originals/photo-${i + 1}.jpg` })));
    const saved = await load(report._id);
    expect(saved).toMatchObject({ status: "pending_approval", job_status: "done", files_generating: false, files_stale: false, revision: 3 });
    expect(Object.keys(saved.files).sort()).toEqual(["docx", "images", "pdf", "xlsx"]);
    expect(Object.values(saved.files).every(url => String(url).startsWith(`https://assetinsight.test/salvage/${report._id}/files/files-generation/attempt-one/`))).toBe(true);
    const artifacts = await PdfReport.find({ report: report._id }).lean(); expect(artifacts).toHaveLength(4);
    expect(artifacts.every(file => file.approvalStatus === "pending" && file.release_status === "pending_release" && String(file.user) === String(details.user))).toBe(true);
    expect(mocks.email).toHaveBeenCalledTimes(1);
    await runSalvageFilesJob(job(report), context("redelivery"));
    expect(mocks.pdf).toHaveBeenCalledTimes(1); expect(await PdfReport.countDocuments()).toBe(4); expect(mocks.email).toHaveBeenCalledTimes(1);
  });
  it("does not publish anything when an export generator fails", async () => {
    const report = await filesReport(); mocks.xlsx.mockRejectedValueOnce(new Error("isolated workbook failure"));
    await expect(runSalvageFilesJob(job(report), context())).rejects.toThrow("isolated workbook failure");
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.uploadPath).not.toHaveBeenCalled();
    expect(await PdfReport.countDocuments()).toBe(0); expect((await load(report._id)).files).toBeUndefined(); expect(mocks.email).not.toHaveBeenCalled();
  });
  it("never exposes a partial file set when artifact storage fails and isolates retry object keys", async () => {
    const report = await filesReport(); mocks.uploadPath.mockRejectedValueOnce(new Error("isolated ZIP failure"));
    await expect(runSalvageFilesJob(job(report), context())).rejects.toThrow("isolated ZIP failure");
    expect(await PdfReport.countDocuments()).toBe(0); expect((await load(report._id)).files).toBeUndefined();
    const failedKeys = mocks.upload.mock.calls.map(call => call[3]); mocks.upload.mockClear();
    await runSalvageFilesJob(job(report), context("retry-attempt"));
    expect(mocks.upload.mock.calls.every(call => !failedKeys.includes(call[3]) && call[3].includes("/retry-attempt/"))).toBe(true);
    expect(await PdfReport.countDocuments()).toBe(4); expect((await load(report._id)).artifact_generation).toBe("files-generation:retry-attempt");
  });
  it.each(["generation", "attempt", "revision"])("fences a stale %s before it can publish newer work", async fence => {
    const report = await filesReport();
    mocks.pdf.mockImplementationOnce(async () => {
      const update = fence === "generation" ? { job_id: "new-generation" } : fence === "attempt" ? { job_execution_token: "new-attempt" } : { revision: 4 };
      await SalvageReport.updateOne({ _id: report._id }, { $set: update });
      return Buffer.from("stale-pdf");
    });
    await expect(runSalvageFilesJob(job(report), context())).rejects.toBeInstanceOf(ReportJobOwnershipLostError);
    const saved = await load(report._id); expect(saved.files).toBeUndefined(); expect(saved.job_status).not.toBe("done");
    expect(mocks.email).not.toHaveBeenCalled();
    // A revision can change only outside normal save guards. Even then the final
    // parent publication must remain fenced; orphaned immutable files stay hidden.
    if (fence !== "revision") expect(await PdfReport.countDocuments()).toBe(0);
  });
  it("refuses superseded generation/revision and revoked queue ownership before rendering", async () => {
    const report = await filesReport(); const stale = job(report); stale.payload.generationToken = "superseded";
    await expect(runSalvageFilesJob(stale, context())).rejects.toBeInstanceOf(ReportJobOwnershipLostError);
    const badRevision = job(report); badRevision.payload.revision = 2;
    await expect(runSalvageFilesJob(badRevision, context())).rejects.toBeInstanceOf(ReportJobOwnershipLostError);
    const revoked = context(); vi.mocked(revoked.assertOwned).mockRejectedValue(new ReportJobOwnershipLostError("Lease revoked"));
    await expect(runSalvageFilesJob(job(report), revoked)).rejects.toThrow("Lease revoked");
    expect(mocks.pdf).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled(); expect(await PdfReport.countDocuments()).toBe(0);
  });
  it("refuses unknown original-photo storage rather than creating an incomplete ZIP", async () => {
    const report = await filesReport({ imageUrls: ["https://unconfigured.example.test/photo.jpg"] });
    await expect(runSalvageFilesJob(job(report), context())).rejects.toThrow("outside configured storage");
    expect(mocks.upload).not.toHaveBeenCalled(); expect(await PdfReport.countDocuments()).toBe(0); expect((await load(report._id)).files).toBeUndefined();
  });
});
