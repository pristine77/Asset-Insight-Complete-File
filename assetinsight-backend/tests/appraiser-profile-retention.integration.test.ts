import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import sharp from "sharp";
import axios from "axios";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import User from "../src/models/user.model.js";
import SalvageReport from "../src/models/salvage.model.js";
import PdfReport from "../src/models/pdfReport.model.js";
import { normalizeSalvageReportData } from "../src/service/salvageReportData.js";
import { runSalvageFilesJob } from "../src/jobs/salvageReportJob.js";
import { loadSalvageAppendixImage, loadSalvageAppendixPdf } from "../src/service/salvageAppendixPages.js";
import { salvageAppraiserProfileFor } from "../src/service/salvageUnitResearch.js";
import { deleteAppraiserSignature, deleteAppraiserCvPdf, uploadAppraiserSignature, uploadAppraiserCvPdf } from "../src/controller/appraiserProfile.controller.js";

const mocks = vi.hoisted(() => ({ pdf: vi.fn(), docx: vi.fn(), xlsx: vi.fn(), remove: vi.fn(), upload: vi.fn(), uploadPath: vi.fn(), read: vi.fn(), assign: vi.fn(), email: vi.fn() }));
vi.mock("../src/service/salvageResearchPipeline.js", () => ({ runEnterpriseSalvageAssessment: vi.fn() }));
vi.mock("../src/service/salvagePdfService.js", () => ({ generateSalvagePdfFromReport: mocks.pdf }));
vi.mock("../src/service/docx/salvageDocxBuilder.js", () => ({ generateSalvageDocx: mocks.docx }));
vi.mock("../src/service/xlsx/salvageXlsxService.js", () => ({ generateSalvageXlsx: mocks.xlsx }));
vi.mock("../src/service/approvalAssignmentService.js", () => ({ assignReportApprover: mocks.assign, sendAssignedApprovalEmail: mocks.email }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  getCurrentR2StorageTarget: () => ({ bucketName: "asset-insight-test", publicBaseUrl: "https://assetinsight.test", publicUrl: "https://assetinsight.test" }),
  deleteFromR2: mocks.remove, uploadBufferToR2: mocks.upload, uploadFilePathToR2: mocks.uploadPath, readR2ObjectBuffer: mocks.read,
  resolveR2ObjectLocationFromUrl: (url: string) => url.startsWith("https://assetinsight.test/") ? { bucketName: "asset-insight-test", key: url.slice("https://assetinsight.test/".length) } : null,
}));

let mongo: MongoMemoryServer;
let png: Buffer, cv: Buffer;
const objects = new Map<string, Buffer>();
const prefix = "https://assetinsight.test/";
const signatureKey = "appraisers/fixture/signature-original.png", cvKey = "appraisers/fixture/cv-original.pdf";
const response = () => { const res: any = { code: 200 }; res.status = vi.fn((code: number) => { res.code = code; return res; }); res.json = vi.fn((body: unknown) => { res.body = body; return res; }); return res; };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  png = await sharp(Buffer.from('<svg width="90" height="30" xmlns="http://www.w3.org/2000/svg"><rect width="90" height="30" fill="white"/><path d="M10 20L30 5L50 20L75 10" stroke="black" fill="none"/></svg>')).png().toBuffer();
  const pdf = await PDFDocument.create(); pdf.addPage().drawText("Synthetic CV"); cv = Buffer.from(await pdf.save());
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  vi.restoreAllMocks(); vi.resetAllMocks(); await mongoose.connection.db!.dropDatabase(); objects.clear();
  objects.set(signatureKey, png); objects.set(cvKey, cv); objects.set("photos/original.png", png);
  vi.spyOn(axios, "get").mockImplementation(async (url: any) => {
    const key = String(url).slice(prefix.length); if (!String(url).startsWith(prefix) || !objects.has(key)) throw new Error("Fixture object unavailable");
    return { data: objects.get(key) } as any;
  });
  mocks.remove.mockImplementation(async (_bucket, key) => { objects.delete(key); });
  mocks.upload.mockImplementation(async (bytes, _type, _bucket, key) => { objects.set(key, bytes); return prefix + key; });
  mocks.uploadPath.mockImplementation(async (_path, _bucket, key) => prefix + key);
  mocks.read.mockImplementation(async (_bucket, key) => { const bytes = objects.get(key); if (!bytes) throw new Error("Missing fixture object"); return bytes; });
  mocks.docx.mockResolvedValue(Buffer.from("synthetic docx")); mocks.xlsx.mockResolvedValue(Buffer.from("synthetic xlsx"));
  mocks.assign.mockResolvedValue(undefined); mocks.email.mockResolvedValue(undefined);
});

async function fixture() {
  const owner = await User.create({ email: "appraiser@example.test", username: "QA Appraiser", password: "fixture-password", appraiserProfile: {
    designation: "CPPA", signatureUrl: prefix + signatureKey, signatureKey, signatureBucket: "asset-insight-test", signaturePublicBaseUrl: prefix.slice(0, -1),
    cvPdfUrl: prefix + cvKey, cvPdfKey: cvKey, cvPdfBucket: "asset-insight-test", cvPdfPublicBaseUrl: prefix.slice(0, -1), cvPdfPages: 1,
  } });
  const data = normalizeSalvageReportData({ report_date: "2026-11-02", date_received: "2026-11-02", date_of_loss: "2026-11-01", next_report_due: "2026-11-03", file_number: "SYNTHETIC-RETENTION", claim_number: "QA-CLAIM", policy_number: "QA-POLICY", appraiser_name: owner.username, appraiser_email: owner.email,
    appraiser_phone: "0000000000", adjuster_name: "QA Adjuster", insured_name: "QA Insured", company_name: "QA Company", company_address: "QA Address", appraiser_comments: "Synthetic", currency: "CAD", language: "en", imageUrls: [prefix + "photos/original.png"] });
  const report = await SalvageReport.create({ ...data, user: owner._id, workflow_version: 1, status: "preview", generation_kind: "files", revision: 3, preview_data: data,
    job_id: "fixture-generation", job_status: "queued", files_generating: true, files_stale: true });
  return { owner, report, data };
}

describe("profile asset retention across active Salvage generation", () => {
  it.each(["delete-signature", "replace-signature", "delete-cv", "replace-cv"] as const)("keeps frozen assets readable during %s and uses the changed profile only for future jobs", async (action) => {
    const { owner, report, data } = await fixture();
    let started!: () => void, resume!: () => void;
    const prepared = new Promise<void>(resolve => { started = resolve; }); const blocked = new Promise<void>(resolve => { resume = resolve; });
    let captured: any;
    mocks.pdf.mockImplementation(async (snapshot) => {
      captured = snapshot.appraiser_profile; started(); await blocked;
      await expect(loadSalvageAppendixImage(captured.signatureUrl, "signature", { png: true })).resolves.toMatch(/^data:image\/png/);
      await expect(loadSalvageAppendixPdf(captured.cvUrl, "CV")).resolves.toMatchObject({ pageCount: 1 });
      return Buffer.from("synthetic pdf");
    });
    const context = { executionToken: "fixture-attempt", signal: new AbortController().signal, assertOwned: vi.fn().mockResolvedValue(undefined) };
    const running = runSalvageFilesJob({ reportId: String(report._id), payload: { generationToken: report.job_id, revision: report.revision }, attempts: 1 } as any, context);
    const settled = running.then(() => null, error => error);
    await prepared;
    expect(captured).toMatchObject({ signatureUrl: prefix + signatureKey, cvUrl: prefix + cvKey });
    const res = response();
    const req: any = { userId: String(owner._id) };
    if (action.startsWith("replace")) req.file = { buffer: action.endsWith("signature") ? png : cv, mimetype: action.endsWith("signature") ? "image/png" : "application/pdf", originalname: action.endsWith("signature") ? "new-signature.png" : "new-cv.pdf" };
    const handler = action === "delete-signature" ? deleteAppraiserSignature : action === "replace-signature" ? uploadAppraiserSignature : action === "delete-cv" ? deleteAppraiserCvPdf : uploadAppraiserCvPdf;
    try {
      await handler(req, res); expect(res.code).toBe(200); expect(mocks.remove).not.toHaveBeenCalled();
      expect(objects.has(signatureKey)).toBe(true); expect(objects.has(cvKey)).toBe(true);
      const current = await User.findById(owner._id).lean(); const future = salvageAppraiserProfileFor(data, current!);
      const field = action.endsWith("signature") ? "signatureUrl" : "cvUrl";
      if (action.startsWith("delete")) expect(future[field]).toBeUndefined(); else expect(future[field]).not.toBe(captured[field]);
    } finally { resume(); }
    expect(await settled).toBeNull();
    const saved = await SalvageReport.findById(report._id).lean();
    expect(saved).toMatchObject({ job_status: "done", files_generating: false, status: "pending_approval" });
    expect(await PdfReport.countDocuments()).toBe(4); expect(mocks.pdf).toHaveBeenCalledTimes(1);
  });
});
